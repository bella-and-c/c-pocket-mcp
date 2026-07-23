# Agent handoff

This repository contains only the public C Pocket MCP bridge. It does not contain the private Enervate application or real Pocket data.

## Project contract

- Product concept and experience design: Bella.
- Architecture, implementation, testing, and documentation: C.
- Keep `pocket_start_context` read-only.
- Keep `pocket_turn_open` as the explicit read-and-mark-seen operation.
- A repeated share after an item was seen must become unseen again.
- The private Drop endpoint returns short text by default; `?response=json` is opt-in.
- Never claim MCP metadata can force a host-side tool invocation.
- C-Memory integration remains optional and may only stage reviewed candidates.

## Safety

- Never commit `.env`, `data/`, media attachments, live hostnames, Drop paths, tokens, personal screenshots, or chat logs.
- Treat `C_POCKET_DROP_SECRET`, `C_POCKET_MCP_PATH`, and `C_POCKET_BRIDGE_TOKEN` as independent secrets.
- Do not widen the repository to include sibling Enervate source without Bella's explicit approval.

## Validation

```bash
npm install
npm run check
```

The server smoke test uses a temporary data directory and must leave no persistent test cards behind.
