# Changelog

## 1.2.1 (2026-09-17)

- README: documented the 160-char answer limit; fixed the ClawHub link (skills path → plugins path).
- Changelog correction: the 1.2.0 "full agent context" note was inaccurate — current code ships the light-context subagent (the full-context change was superseded during the PR #7 merge).

## 1.2.0 (2026-09-17)

- Voice answer display limit raised 80 → 160 chars.
- Voice subagent runs light-context with an under-160-char answer prompt (fits display banners).
- VAD-controlled recording documented (Snarling-side capture replaces fixed 20s).
- Packaging: refreshed `openclaw.build` metadata (tested against 2026.9.1), added manifest category, README install/update/allowlist instructions aligned with ClawHub.
- **First release of the code plugin to ClawHub under `openclaw-voice-bridge`** (previous ClawHub code-plugin release was 1.0.0).

## 1.1.0

- Prior release; see git history.

## 1.0.0 (2026-06-24)

- Initial code-plugin release on ClawHub.