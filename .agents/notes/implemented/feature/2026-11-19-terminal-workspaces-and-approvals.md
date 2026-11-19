# Agent Note: Workspaces and approvals in the terminal CLI

Status: implemented

English | [中文](2026-11-19-terminal-workspaces-and-approvals.zh.md)

## Problem

Terminal users need to start from the directory their shell is already in, choose a workspace and Agent for a new directory, and make permission decisions for the session that actually executes the tool.

## Decision

The interactive launcher starts the pinned official DSH Host on loopback. A separate runtime installation keeps the Host and its Node Remote client on the same Cordis version. The terminal registers an authenticated approval responder for the active session. The Host owns workspace records, the Agent roster, session history, the permission catalog, and tool enforcement.

Startup uses the nearest registered workspace. The fork's Host command changes the session's active working directory through the official service. The session header continues to identify its workspace and sandbox root. Permission changes for the current session use the Host command. Future defaults use the settings revision.

## Alternatives considered

Installing the pinned Host in the fork's workspace dependency graph resolved incompatible Cordis peers into the same installation. An isolated runtime lock keeps each plugin graph intact.

The Web Host composition records workspace diffs. A Git snapshot can delay the tool pipeline before approval becomes available. The terminal overlay disables that recorder.

## Consequences

The terminal uses a dedicated Host home for workspace registration, permission defaults, and session recovery. The bundled profile handles the documented legacy flags. The terminal shows tool status and individual approvals.

## Verification

The [built terminal tests](../../../../apps/cli/tests/terminal-shells.e2e.ts) exercise PowerShell and Git Bash against a local model fixture. The [Host approval test](../../../../apps/cli/tests/terminal-approval.e2e.ts) matches audit receipts to decisions and counts actual file writes.
