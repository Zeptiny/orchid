---
title: Message Queue
date: 2026-07-22
type: requirements
status: confirmed
---

# Message Queue

## Summary

A message queue above the input field that lets the user compose and manage messages while the agent is working. Each queued message targets one of two triggers — "with next request" (joins the current chain before the next LLM API call) or "after chain ends" (starts a new chain when the current one terminates). The queue is strict FIFO, auto-sends on trigger, and the input field switches to queue-only mode while the agent is streaming.

---

## Problem Frame

When the agent is mid-turn — streaming, executing tools, looping — the user often knows what they want to say next but has nowhere to put it. They either wait idle, or type into the input field and risk sending at the wrong moment. A queue lets the user stage follow-up messages with precise control over when each one fires, without interrupting the agent's current work.

---

## Requirements

**Queue management**

- R1. The user can add a message to the queue from the input field while the agent is streaming.
- R2. The user can edit the text of a queued message.
- R3. The user can delete a queued message.
- R4. The user can reorder queued messages.
- R5. The user can change a queued message's trigger between "with next request" and "after chain ends."

**Trigger semantics**

- R6. "With next request" injects the message as user input before the next LLM API call, within the current chain. The message appears in the chat stream as a user message.
- R7. "After chain ends" sends the message as a new user message once the chain terminates (completed, interrupted, or failed), starting a new chain.
- R8. When multiple "with next request" messages are eligible at the same trigger point, they batch into the same API call in queue order.
- R9. "With next request" messages that never reach a next API call (chain completes without further tool calls, or the user cancels) fire at chain termination.

**Queue processing**

- R10. The queue is strict FIFO. A message must fire before any message behind it is eligible.
- R11. Messages auto-send when their trigger condition is met — no confirmation prompt.
- R12. A message currently being edited does not fire. The queue holds until editing ends.

**Input field behavior**

- R13. While the agent is streaming, the input field sends to the queue instead of sending immediately.
- R14. While the agent is idle, the input field behaves normally (immediate send).

**UI**

- R15. Queued messages render above the input field, visible at all times while the queue is non-empty.
- R16. Each queue item shows a text preview, its trigger type, and controls for edit, delete, and reorder.

---

## Key Decisions

- **Strict FIFO over trigger-independent ordering.** A "after chain ends" message at the front blocks "with next request" messages behind it until the chain ends. Simpler mental model — the queue is a single ordered line.
- **Auto-send over prompted send.** No confirmation dialog when a trigger fires. The user's veto mechanism is editing (which holds the queue), not a last-moment approval step.
- **Queue-only input during streaming.** The user cannot send immediate messages while the agent is working. This prevents race conditions and keeps the interaction model simple: streaming = queue, idle = send.
- **Ephemeral queue.** Queued messages live in memory, scoped to the active session. They are not persisted across session switches or app restarts.

---

## Key Flows

- F1. Queue and fire mid-chain
  - **Trigger:** User types and submits while agent is streaming.
  - **Steps:** Message appended to queue with default trigger. Tools finish executing. All "with next request" messages at the front of the queue batch into the next API call as user input. Agent continues with the injected context.
  - **Covered by:** R1, R6, R8, R10, R11, R13

- F2. Queue and fire at chain end
  - **Trigger:** User queues a message with "after chain ends" trigger.
  - **Steps:** Chain terminates (completed, interrupted, or failed). Message auto-sends as a new user message. A new chain begins.
  - **Covered by:** R1, R7, R10, R11

- F3. Cancel flushes "with next request"
  - **Trigger:** User cancels the stream (Esc) while "with next request" messages are queued.
  - **Steps:** Chain terminates as interrupted. "With next request" messages at the front fire immediately at chain termination. They appear as user messages and start a new chain.
  - **Covered by:** R9, R10, R11

- F4. Edit holds the queue
  - **Trigger:** User is editing the front message when its trigger condition is met.
  - **Steps:** Queue processing pauses. No messages fire. User finishes editing. Queue resumes — the edited message fires if its trigger is still met.
  - **Covered by:** R2, R10, R12

---

## Acceptance Examples

- AE1. Mid-chain batch injection
  - **Given:** Agent is streaming, queue has [A: next-request, B: next-request, C: chain-end]
  - **When:** Tools finish and the next API call is about to fire
  - **Then:** A and B inject into the same API call as user messages. C remains queued.

- AE2. FIFO blocking across trigger types
  - **Given:** Queue has [A: chain-end, B: next-request]
  - **When:** Tools finish and the next API call is about to fire
  - **Then:** B does not fire. A blocks the queue. Both wait until the chain ends. A fires first (new chain), then B fires in the new chain's next request.

- AE3. Cancel flush
  - **Given:** Agent is streaming, queue has [A: next-request, B: chain-end]
  - **When:** User presses Esc to cancel
  - **Then:** Chain terminates. A fires immediately (degraded to chain-end behavior). B fires next. Both start new chains sequentially.

- AE4. No tool calls — natural degradation
  - **Given:** Agent responds without tool calls, queue has [A: next-request]
  - **When:** Agent finishes its response and the chain completes
  - **Then:** A fires at chain termination since no next API call occurred.

---

## Scope Boundaries

- Queue state is not persisted. Switching sessions or restarting the app discards queued messages.
- No rich content in queued messages (attachments, slash commands) — plain text only.
- No queue limit enforcement.
- No undo for deleted queued messages.
- Queue is not visible in the sidebar or any surface other than above the input field.

---

## Outstanding Questions

**Deferred to planning:**

- Default trigger for newly queued messages — "with next request" or "after chain ends"?
- Reorder interaction — drag-and-drop, up/down buttons, or both?
- Visual treatment of the queue (collapsed/expanded, max visible items before scroll).
- Whether queued messages support the same multiline input as the normal input field.
- Behavior when a queued message's text is emptied during editing (auto-delete or prevent?).
