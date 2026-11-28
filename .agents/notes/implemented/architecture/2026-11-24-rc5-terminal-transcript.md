# Agent Note: Separate live output from committed terminal history

Status: implemented

English | [中文](2026-11-24-rc5-terminal-transcript.zh.md)

## Problem

The terminal follows committed Session events, which arrive too late to show partial responses. The terminal also needs to remove output from a failed attempt when the Host retries.

## Decision

The rc.5 terminal opts into assistant presentation frames on its existing Session subscription. It uses the Host decoder for the opening stream prefix and applies subsequent chunks only to the matching attempt and index. Committed assistant messages replace the preview. Attempt abandonment, retry and Session switches clear it. The transcript opens over the same view data and keeps the draft when closed.

## Alternatives considered

Polling history or replaying each committed message as a stream would show output only after the model had finished. Consuming the live frames lets the terminal show progress and preserves the durable log as the source for history.

## Consequences

The terminal keeps a bounded preview for each displayed block and uses the Host's committed message for replay. Providers that supply no reasoning text still show the active model stage. Usage totals reflect the Session events seen by the terminal.

The Ctrl+T transcript shows the current phase and follows the latest visible lines, including streamed model text and committed tool updates. Scrolling back anchors the viewport to its current top row while new content arrives. End returns to the latest row. Each tool call has a three-row output preview and uses Ctrl+O to toggle the retained result.

The composer clears its live input whenever a line is submitted, including when text and Enter arrive in one terminal chunk. While the Host reports active work, `/steer` submits an instruction for the next Agent step, and normal input uses the next-turn queue.

Script readers follow the same Session event stream on the shared Host. The script steering command sends an instruction through the same Host RPC as the terminal. Session-scoped unsent text can be restored locally without re-sending any message.
