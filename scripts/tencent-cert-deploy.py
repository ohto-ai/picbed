#!/usr/bin/env python3
"""上传证书到腾讯云 SSL 证书管理，并绑定到 COS 存储桶自定义域名。

流程：
1. UploadCertificate（腾讯云 TC3-HMAC-SHA256 签名）→ 得到 CertificateId；
   相同证书已存在时返回 RepeatCertId，直接复用，避免证书列表堆积
2. PUT Bucket domaincertificate（COS XML API V5 签名）→ 绑定到 COS 自定义域名
3. GET Bucket domaincertificate 校验绑定状态为 Enabled

仅使用 Python 标准库，无需 pip 安装，可直接在 GitHub Actions 的 runner 上运行。

用法：
    python3 scripts/tencent-cert-deploy.py \
        --domain album.ohtoai.top \
        --bucket album-1255316209 \
        --region ap-shanghai \
        --cert /path/fullchain.cer \
        --key  /path/album.ohtoai.top.key

环境变量：
    TENCENT_SECRET_ID / TENCENT_SECRET_KEY（建议使用最小权限的子账号密钥）
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


# ---------------------------------------------------------------- 签名工具

def hmac_hex(key: bytes, msg: str, algo) -> str:
    return hmac.new(key, msg.encode("utf-8"), algo).hexdigest()


def urlenc(s: str) -> str:
    """与官方 SDK 一致：仅保留 RFC3986 非保留字符（-_.~），百分号大写。"""
    return urllib.parse.quote(s, safe="-_.~")


def cos_signature(secret_id: str, secret_key: str, method: str,
                  host: str, params: dict, headers: dict) -> str:
    """COS XML API V5 签名。params/headers 均为 {key: value} 字典。"""
    now = int(time.time())
    key_time = f"{now - 60};{now + 3600}"
    sign_key = hmac_hex(secret_key.encode(), key_time, hashlib.sha1)

    params = {k.lower(): v for k, v in (params or {}).items()}
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    param_list = ";".join(sorted(params))
    param_str = "&".join(f"{urlenc(k)}={urlenc(v)}" for k, v in sorted(params.items()))
    header_list = ";".join(sorted(headers))
    header_str = "&".join(f"{urlenc(k)}={urlenc(v)}" for k, v in sorted(headers.items()))

    http_string = f"{method.lower()}\n/\n{param_str}\n{header_str}\n"
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    signature = hmac_hex(sign_key.encode(), string_to_sign, hashlib.sha1)

    return (
        f"q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}"
        f"&q-key-time={key_time}&q-header-list={header_list}"
        f"&q-url-param-list={param_list}&q-signature={signature}"
    )


# ---------------------------------------------------------------- 请求封装

def cos_request(secret_id: str, secret_key: str, method: str,
                bucket: str, region: str, params: dict,
                body: str = None, content_type: str = None):
    """向 COS XML API 发请求，返回 (status, 响应文本)。"""
    host = f"{bucket}.cos.{region}.myqcloud.com"
    url = f"https://{host}/"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    # 参与签名的头必须与实际发送的一致
    signed_headers = {"Host": host}
    if content_type and body:
        signed_headers["Content-Type"] = content_type
    auth = cos_signature(secret_id, secret_key, method, host, params, signed_headers)

    req_headers = {"Authorization": auth}
    if content_type and body:
        req_headers["Content-Type"] = content_type
    req = urllib.request.Request(
        url, data=body.encode() if body else None, method=method, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def tc3_request(secret_id: str, secret_key: str, service: str,
                action: str, version: str, payload: dict, region: str = None) -> dict:
    """腾讯云 API 3.0 请求（TC3-HMAC-SHA256 签名），返回解析后的 JSON。"""
    host = f"{service}.tencentcloudapi.com"
    timestamp = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(timestamp))
    ct = "application/json; charset=utf-8"
    body = json.dumps(payload, separators=(",", ":")).encode()

    canonical_headers = f"content-type:{ct}\nhost:{host}\n"
    signed_headers = "content-type;host"
    canonical_request = "\n".join([
        "POST", "/", "",
        canonical_headers, signed_headers, hashlib.sha256(body).hexdigest(),
    ])
    scope = f"{date}/{service}/tc3_request"
    string_to_sign = "\n".join([
        "TC3-HMAC-SHA256", str(timestamp), scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])
    secret_date = hmac.new(("TC3" + secret_key).encode(), date.encode(), hashlib.sha256).digest()
    secret_service = hmac.new(secret_date, service.encode(), hashlib.sha256).digest()
    secret_signing = hmac.new(secret_service, b"tc3_request", hashlib.sha256).digest()
    signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    headers = {
        "Authorization": (
            f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
        "Content-Type": ct,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Timestamp": str(timestamp),
        "Host": host,
    }
    if region:
        headers["X-TC-Region"] = region

    req = urllib.request.Request(f"https://{host}/", data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{action} HTTP {e.code}: {e.read().decode('utf-8', 'replace')}")


def tc3_error(resp: dict, action: str) -> RuntimeError:
    err = (resp.get("Response") or {}).get("Error") or {}
    return RuntimeError(f"{action} 失败: {err.get('Code')} - {err.get('Message')}")


# ---------------------------------------------------------------- 主流程

def main():
    parser = argparse.ArgumentParser(description="上传证书到腾讯云 SSL 并绑定 COS 自定义域名")
    parser.add_argument("--domain", required=True, help="自定义域名，如 album.ohtoai.top")
    parser.add_argument("--bucket", required=True, help="COS 存储桶，如 album-1255316209")
    parser.add_argument("--region", required=True, help="COS 地域，如 ap-shanghai")
    parser.add_argument("--cert", required=True, help="fullchain 证书 PEM 文件路径")
    parser.add_argument("--key", required=True, help="私钥 PEM 文件路径")
    args = parser.parse_args()

    secret_id = os.environ.get("TENCENT_SECRET_ID") or ""
    secret_key = os.environ.get("TENCENT_SECRET_KEY") or ""
    if not secret_id or not secret_key:
        sys.exit("缺少环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY")

    with open(args.cert, encoding="utf-8") as f:
        cert_pem = f.read()
    with open(args.key, encoding="utf-8") as f:
        key_pem = f.read()

    # 1. 上传到 SSL 证书管理（相同证书已存在时复用，不重复上传）
    print(f"[1/3] 上传证书到腾讯云 SSL 证书管理（{args.domain}）...")
    resp = tc3_request(secret_id, secret_key, "ssl", "UploadCertificate", "2019-12-05", {
        "CertificatePublicKey": cert_pem,
        "CertificatePrivateKey": key_pem,
        "CertificateType": "SVR",
        "Alias": args.domain,
        "Repeatable": False,
    })
    data = resp.get("Response") or {}
    if "Error" in data:
        raise tc3_error(resp, "UploadCertificate")
    cert_id = data.get("CertificateId") or data.get("RepeatCertId") or ""
    if not cert_id:
        raise RuntimeError(f"UploadCertificate 未返回证书 ID: {resp}")
    print(f"    证书 ID: {cert_id}"
          + ("（相同证书已存在，复用）" if data.get("RepeatCertId") else ""))

    # 2. 绑定到 COS 存储桶的自定义域名
    print(f"[2/3] 绑定证书到 COS 自定义域名 {args.domain}（{args.bucket}）...")
    xml_body = (
        "<DomainCertificate>"
        "<CertificateInfo>"
        "<CertType>CustomCert</CertType>"
        "<CustomCert>"
        f"<Cert>{cert_pem}</Cert>"
        f"<PrivateKey>{key_pem}</PrivateKey>"
        "</CustomCert>"
        "</CertificateInfo>"
        "<DomainList>"
        f"<DomainName>{args.domain}</DomainName>"
        "</DomainList>"
        "</DomainCertificate>"
    )
    status, text = cos_request(secret_id, secret_key, "PUT", args.bucket, args.region,
                               {"domaincertificate": ""},
                               body=xml_body, content_type="application/xml")
    if not 200 <= status < 300:
        raise RuntimeError(f"绑定失败 HTTP {status}: {text}")

    # 3. 校验绑定状态
    print("[3/3] 校验 COS 域名证书绑定状态...")
    status, text = cos_request(secret_id, secret_key, "GET", args.bucket, args.region,
                               {"domaincertificate": "", "domainname": args.domain})
    if not 200 <= status < 300:
        raise RuntimeError(f"校验失败 HTTP {status}: {text}")
    try:
        root = ET.fromstring(text)
        state = next((el.text for el in root.iter() if el.tag == "Status"), None)
    except ET.ParseError:
        state = None
    if state != "Enabled":
        raise RuntimeError(f"校验失败：绑定状态为 {state!r}（响应：{text}）")

    print(f"完成：证书 {cert_id} 已绑定到 {args.domain}，状态 Enabled")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(f"::error:: {e}")
