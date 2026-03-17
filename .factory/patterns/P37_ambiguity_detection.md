# P37: Ambiguity Detection & Resolution

**Category**: Planning
**Abbreviation**: Ambiguity-Detect

## Pattern

Before executing any task, score its ambiguity level. If ambiguity exceeds threshold, ask clarifying questions before proceeding. Never assume — resolve.

## Rule

```
Ambiguity score >= 0.6 → MUST ask clarifying questions before execution.
Ambiguity score 0.3-0.6 → State assumptions explicitly, proceed with caution.
Ambiguity score < 0.3 → Execute directly (task is clear).
```

## Ambiguity Signals

### High Ambiguity (score += 0.3 each)

- Pronouns without antecedents: "it", "that", "the thing", "the module"
- Relative references: "similar to X", "like before", "the usual way"
- Unspecified targets: "optimize", "improve", "fix" without what/where
- Missing scope: "update the code", "change the config" (which code? which config?)
- Contradictory requirements: "fast AND thorough", "simple AND comprehensive"

### Medium Ambiguity (score += 0.2 each)

- Implicit assumptions: "obviously", "of course", "naturally"
- Vague quantifiers: "some", "a few", "several", "many"
- Undefined terms: domain-specific jargon not in project context
- Missing success criteria: no way to verify "done"
- Underspecified format: "output the results" (to file? stdout? JSON? text?)

### Low Ambiguity (score += 0.1 each)

- Optional parameters not specified
- Style preferences not stated
- Error handling strategy not defined
- Edge case behavior not specified

## Question Generation Rules

1. Ask the MINIMUM number of questions needed to resolve ambiguity
2. Provide sensible defaults with each question ("I'll assume X unless you say otherwise")
3. Group related questions together
4. Never ask more than 5 questions at once
5. Prioritize questions that block execution over nice-to-know

## Question Templates

### For unspecified targets:

```
"You mentioned [action] — which specific [file/module/component] should I target?"
```

### For missing scope:

```
"Should this change apply to [option A] or [option B]? (I'll default to [A] if unspecified)"
```

### For undefined success criteria:

```
"How should I verify this is working correctly? [suggest test/check]"
```

### For contradictory requirements:

```
"[Requirement A] and [Requirement B] may conflict. Which takes priority?"
```

## Implementation

1. Parse task instruction for ambiguity signals
2. Calculate ambiguity score (0.0 - 1.0)
3. If score >= 0.6: Generate and ask clarifying questions
4. If score 0.3-0.6: State assumptions, proceed
5. If score < 0.3: Execute directly
6. Record resolution in memory for future reference

## Examples

### Clear Task (score ~0.1)

Task: "Add a `createdAt` timestamp field to the User model in src/models/user.ts"
→ Execute directly. Target, action, and location are all specified.

### Moderate Ambiguity (score ~0.4)

Task: "Optimize the database queries"
→ State assumption: "I'll focus on the slowest queries in src/db/ based on recent logs"
→ Proceed with stated assumption

### High Ambiguity (score ~0.8)

Task: "Fix the bug"
→ Ask: "Which bug are you referring to? Is there an error message, stack trace, or issue number?"
→ Wait for clarification before proceeding

## Anti-Pattern

- Guessing what the user means and proceeding silently
- Asking too many questions (analysis paralysis)
- Asking questions that could be answered by reading the codebase
- Ignoring ambiguity and hoping for the best
- Re-asking questions already answered in the conversation
