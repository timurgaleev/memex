#!/usr/bin/env python3
"""
One-shot Gmail OAuth bootstrap.

Reads the Desktop OAuth client_id + client_secret from
`openclaw/gmail-oauth` Secrets Manager entry, opens a browser for
user consent, captures the auth code, exchanges it for a refresh
token, and writes the refresh_token back into the same secret.

Usage (from your Mac, NOT from the EC2 — needs a browser):

    pip install google-auth-oauthlib boto3
    AWS_PROFILE=bedrock python3 scripts/gmail-oauth-bootstrap.py

After it finishes you'll see "refresh_token stored". From then on the
recipe inside memex just calls `secretsmanager:GetSecretValue` and
uses the refresh_token to mint short-lived access tokens.

This script is run-once. If the refresh_token is ever invalidated
(user revoked, app verification status changed) just re-run.

Requires the EC2's IAM user (or your local AWS_PROFILE) to have
`secretsmanager:GetSecretValue` + `secretsmanager:PutSecretValue` on
the gmail-oauth secret. The EC2 IAM role got PutSecretValue scoped to
memex-public-bearer-* only — for this bootstrap from the Mac use
your bedrock profile's admin role.
"""
from __future__ import annotations

import json
import sys

try:
    import boto3
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError as exc:
    sys.stderr.write(
        "missing dependency: pip install google-auth-oauthlib boto3\n"
    )
    raise SystemExit(1) from exc


REGION = "eu-west-1"
SECRET_ID = "openclaw/gmail-oauth"

# Read-only is enough for ingest. Bump to gmail.modify if a future
# recipe needs to label or move messages.
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def main() -> int:
    sm = boto3.client("secretsmanager", region_name=REGION)
    raw = sm.get_secret_value(SecretId=SECRET_ID)["SecretString"]
    secret = json.loads(raw)

    if not secret.get("client_id") or not secret.get("client_secret"):
        sys.stderr.write(
            f"{SECRET_ID} missing client_id / client_secret — "
            "fill those before running the bootstrap.\n"
        )
        return 1

    flow = InstalledAppFlow.from_client_config(
        {
            "installed": {
                "client_id": secret["client_id"],
                "client_secret": secret["client_secret"],
                "redirect_uris": ["http://localhost"],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        SCOPES,
    )

    print("Opening browser for Google consent — pick the Gmail account "
          "the recipe should ingest from.")
    creds = flow.run_local_server(port=0, prompt="consent")

    if not creds.refresh_token:
        sys.stderr.write(
            "Google did not return a refresh_token. This usually means "
            "you've already authorized this client — revoke at "
            "https://myaccount.google.com/permissions then re-run.\n"
        )
        return 1

    secret["refresh_token"] = creds.refresh_token
    sm.put_secret_value(
        SecretId=SECRET_ID,
        SecretString=json.dumps(secret, separators=(",", ":")),
    )
    print(f"refresh_token stored in {SECRET_ID}")
    print(
        "next: ping me, I land the Gmail recipe PR which polls the "
        "mailbox via this credential."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
