# @jawstack/cli

Project-level JawStack command line interface.

Commands:

- `jawstack doctor`
- `jawstack manifest`
- `jawstack deploy <stage>`
- `jawstack smoke <stage>`
- `jawstack destroy <stage>`

The CLI loads `jawstack.config.ts`, validates resource and cost guardrail metadata, delegates deploy/destroy to CDK, and runs the Work Requests smoke path.

Status: `0.0.1` dogfood baseline. The smoke command is still Work Request-specific.
