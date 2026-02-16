# Security Policy

## Supported Versions

Security fixes are applied to the latest `main` branch state.

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Report privately via:

1. Email: `jasond1016@gmail.com`
2. Include:
   - affected version/commit
   - reproduction steps
   - impact assessment
   - any proof-of-concept details

## Response Expectations

1. Initial acknowledgment: within 72 hours
2. Triage and severity assessment: within 7 days
3. Fix timeline depends on severity and exploitability

## Secret Handling

1. Never commit API keys or tokens.
2. Before pushing, run:
```bash
gitleaks git
```
3. If a secret is exposed:
   - rotate/revoke immediately
   - remove from history if needed
   - document remediation in the corresponding release notes
