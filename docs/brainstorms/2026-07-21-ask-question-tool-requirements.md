---
title: "ask_question Tool"
date: 2026-07-21
type: requirements
status: confirmed
---

# ask_question Tool

## Summary

A new tool that pauses an agent's turn to present the user (or the main agent, for subagent calls) with a stepper of single-choice and multi-choice questions. Each question always includes a free-text field. The widget overlays the input area — the user can navigate the UI and chat history but cannot send messages until they answer or cancel.

---

## Problem Frame

Agents currently have no way to ask the user a structured question mid-turn. When an agent needs clarification or a decision, it can only emit text and end its turn, forcing the user to read a wall of prose, formulate a response, and re-prompt. This loses the agent's train of thought and adds round-trip latency.

For subagents, the problem is worse: a subagent that needs guidance must either guess or fail. The main agent has no visibility into subagent uncertainty until the subagent completes (or errors), and no way to intervene mid-flight.

---

## Requirements

**Question model**

- R1. A tool call contains one or more questions, presented as a stepper (one at a time, Next/Back navigation, submit on the last question).
- R2. Each question has a type: single-choice (exactly one selection) or multi-choice (zero or more selections).
- R3. Each question has a title (required) and a description (optional).
- R4. Each choice has a label (required) and a description (optional).
- R5. Every question always includes a free-text input field, regardless of type.
- R6. The agent receives both the selection(s) and the free-text content for each answered question.

**User interaction (main agent → user)**

- R7. The question widget overlays the input area. The user can navigate the UI, browse chat history, and move around, but cannot send a message until the questions are answered or cancelled.
- R8. The user can skip an individual question. A skipped question returns "skipped" as its answer to the agent. The stepper advances to the next question.
- R9. The user can cancel the entire question set. Cancelling closes the widget, saves a cancelled tool result to the session history (so the agent sees it on future turns), and aborts the current turn/chain — the result is not fed back to the LLM in the current turn.
- R10. After answering, the completed widget persists in chat history showing what was selected and written.

**Subagent escalation (subagent → main agent)**

- R11. Subagents can call `ask_question`. The question routes to the main agent, not directly to the user.
- R12. When the main agent is in `wait_for_subagent` and a subagent asks a question, `wait_for_subagent` returns early with the pending question(s).
- R13. When the main agent is not in `wait_for_subagent`, the question queues. The dynamic system prompt is updated to reflect the pending question on the main agent's next turn.
- R14. A new `answer_subagent` tool lets the main agent respond to a subagent's pending question with answers or a decline.
- R15. The main agent can forward a subagent's question to the user by calling `ask_question` itself, then relay the user's answer via `answer_subagent`.
- R16. When the main agent declines, the subagent's `ask_question` resolves with a declined status. The subagent continues its work without an answer.
- R17. Multiple subagents can have pending questions simultaneously. `wait_for_subagent` surfaces all pending questions for the requested subagent IDs.

---

## Key Decisions

- **Cancel aborts the stream.** Cancelling the question set terminates the turn via the existing AbortController plumbing rather than returning a tool result. This is the first tool that can end a turn from within.
- **Main agent is an active decision-maker.** Subagent questions route to the main agent, which chooses to answer directly, search/investigate first, forward to the user, or decline. The user never answers a subagent's question directly.
- **Queue, don't interrupt.** When the main agent is mid-turn, subagent questions queue silently. Awareness comes from the dynamic system prompt on the next turn, not mid-stream interruption.
- **Stepper, not scrollable list.** Multiple questions are presented one at a time with Next/Back navigation, not as a scrollable form.

---

## Actors

- A1. **User** — answers or cancels questions from the main agent. Navigates the UI freely while the widget is active but cannot send messages.
- A2. **Main agent** — asks the user questions mid-turn. Receives and responds to subagent questions (answer, forward, or decline).
- A3. **Subagent** — asks questions that route to the main agent. Receives answers, declines, or skips as tool results.

---

## Key Flows

- F1. Main agent asks the user
  - **Trigger:** Main agent calls `ask_question` with one or more questions.
  - **Actors:** A1, A2
  - **Steps:** Agent turn pauses. Widget overlays the input area. User steps through questions (select, type, skip, or cancel). On submit, the tool result returns all answers to the agent and the turn resumes. On cancel, a cancelled result is saved to session history and the turn aborts.
  - **Covered by:** R1–R10

- F2. Subagent asks the main agent (main agent waiting)
  - **Trigger:** Subagent calls `ask_question` while the main agent is in `wait_for_subagent`.
  - **Actors:** A2, A3
  - **Steps:** Subagent's handler pauses. `wait_for_subagent` returns early with the pending question. Main agent decides: answer via `answer_subagent`, forward to user (F3), or decline. Subagent's handler resolves with the answer or declined status.
  - **Covered by:** R11, R12, R14, R16, R17

- F3. Main agent forwards a subagent question to the user
  - **Trigger:** Main agent receives a subagent question and calls `ask_question` itself.
  - **Actors:** A1, A2, A3
  - **Steps:** Main agent calls `ask_question` with the subagent's questions. User answers via F1. Main agent relays the answer to the subagent via `answer_subagent`. Subagent's handler resolves.
  - **Covered by:** R15

- F4. Subagent asks while main agent is busy
  - **Trigger:** Subagent calls `ask_question` while the main agent is mid-turn (not in `wait_for_subagent`).
  - **Actors:** A2, A3
  - **Steps:** Question queues. Subagent's handler awaits. Dynamic system prompt updated. On the main agent's next turn, it sees the pending question and responds via `answer_subagent` (or lets it queue further).
  - **Covered by:** R13, R14

---

## Scope Boundaries

**In scope:**
- `ask_question` tool for main agent and subagents
- `answer_subagent` tool for the main agent
- Question widget overlaying the input area with stepper navigation
- Dynamic system prompt updates for pending subagent questions

**Out of scope:**
- Mid-turn interruption of the main agent for subagent questions
- User answering a subagent's question directly (always routed through the main agent)
- Conditional questions (show Q2 based on Q1's answer)
- Question timeouts or auto-skip
- Required-answer validation (all questions are skippable)

---

## Outstanding Questions

**Deferred to planning:**
- Exact widget rendering: how the overlay integrates with the existing input component and chat stream layout.
- How the completed question widget renders in chat history (collapsed summary vs. full replay).
- Whether the main agent's `ask_question` call for forwarding should visually indicate it originated from a subagent.
- Subagent system prompt guidance for handling declined answers gracefully.
- How `wait_for_subagent` formats multiple pending questions from different subagents in a single early return.
