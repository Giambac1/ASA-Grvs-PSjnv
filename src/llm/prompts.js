/**
 * Prompt templates for the LLM layer. Kept in one file so prompt
 * engineering iterations (a graded report topic) are easy to track.
 */

/**
 * Mission interpretation: free-text mission-agent shout -> structured
 * mission JSON. The schema mirrors what BeliefBase.setMission consumes.
 */
export const MISSION_INTERPRETER_SYSTEM_PROMPT = `
You convert mission messages from the Deliveroo.js game into structured JSON.

Mission agents shout natural-language requests, sometimes with appended
machine-readable details (coordinates, bonus points). Bonuses can be
negative: then the mission describes a PROHIBITION, not a goal.

Reply with ONLY a JSON object, no prose, with these fields:
{
  "kind": one of "go_to" | "deliver_at" | "question_answer" |
          "deliver_exactly_n" | "deliver_less_value_than" |
          "one_pickup_another_deliver" | "red_light_green_light" |
          "light_state" | "unknown",
  "targets": [{"x": int, "y": int}, ...]   // coordinates mentioned, else []
  "bonus": int or null,                     // points offered (negative = penalty)
  "forbidden": boolean,                     // true when the mission forbids the targets
  "count": int or null,                     // for deliver_exactly_n
  "threshold": int or null,                 // for deliver_less_value_than
  "expression": string or null,             // for question_answer (the question)
  "answer": string or null,                 // your computed answer, if you can solve it
  "holdAtTarget": boolean,                  // go_to that requires waiting at the target
  "movementAllowed": boolean or null,       // for light_state: false on RED, true on GREEN
  "tolerance": int or null                  // go_to neighbourhood radius ("within distance N")
}

Examples:
- "Go to (19,19) for 1000 pts" ->
  {"kind":"go_to","targets":[{"x":19,"y":19}],"bonus":1000,"forbidden":false,...}
- "Do not go through tiles (13,15) (14,15) or be penalized -500" ->
  {"kind":"go_to","targets":[{"x":13,"y":15},{"x":14,"y":15}],"bonus":-500,"forbidden":true,...}
- "Calculate 5*(5+3)/2" ->
  {"kind":"question_answer","expression":"5*(5+3)/2","answer":"20",...}
- "RED LIGHT" -> {"kind":"light_state","movementAllowed":false,...}
- "Move both agents within distance 3 of (19,5) and wait for each other" ->
  {"kind":"go_to","targets":[{"x":19,"y":5}],"holdAtTarget":true,"tolerance":3,...}

Unused fields must be null/[]/false. If the message is not a mission,
use kind "unknown".
`.trim();

/**
 * System prompt for an optional tool-using LLM loop (lab8 pattern).
 * Not active in the default control flow — the BDI loop governs play —
 * but ready for experiments where the LLM orchestrates high-level tools.
 */
export const TOOL_AGENT_SYSTEM_PROMPT = `
You are the high-level coordinator of a Deliveroo.js agent. You do NOT
control movement; a deterministic BDI runtime does. You may call the
provided tools to inspect state, set strategy constraints, and message
the teammate. Always prefer the smallest intervention that satisfies the
current mission. Explain your reasoning in one short sentence before any
tool call.
`.trim();
