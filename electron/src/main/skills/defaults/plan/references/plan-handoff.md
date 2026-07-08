---
description: Plan handoff instructions -- post-plan-writing options, document review, final checks, and next-step routing.
---

# Plan Handoff

This file contains post-plan-writing instructions: document review, post-generation options. Load it after the plan file has been written and the confidence check (5.3.1-5.3.7) is complete.

## 5.3.8 Document Review

After the confidence check, review the plan for coherence, feasibility, and scope alignment before presenting options.

## 5.3.9 Final Checks and Cleanup

Before proceeding to post-generation options:
- Confirm the plan is stronger in specific ways, not merely longer
- Confirm the planning boundary is intact
- Confirm origin decisions were preserved when an origin document exists

## 5.4 Post-Generation Options

**Question:** "Plan ready at `<absolute path to plan>`. What would you like to do next?"

**Options:**
1. **Execute the plan** - Begin implementing this plan by handing off to `work`
2. **Review specific sections** - Discuss or refine particular parts of the plan
3. **Done for now** - Pause; the plan file is saved and can be resumed later

**Routing.** Act on the user's selection -- do not just announce it.

- **Execute the plan** -- Invoke the `work` skill, passing the plan path as the skill argument. Do not merely tell the user to run it -- fire the invocation now so the plan executes in this session.
- **Review specific sections** -- Engage in dialogue about the plan sections the user wants to discuss. After revisions, re-render this menu.
- **Done for now** -- Display a brief confirmation that the plan file is saved and end the turn. Do not start follow-up work without an explicit further user prompt.

**Completion check:** This skill is not complete until the post-generation menu above has been presented, the user has selected an action, and the routing for that selection has been executed.
