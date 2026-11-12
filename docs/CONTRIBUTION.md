# Contribution and AI assistance

## Who did what

**Jon Johnson** defined, in a written specification:

- the product concept ("Can you rescue a customer implementation?") and the three scenarios
- the requirements: an explicit state machine, typed records, a deterministic clock, repeatable seeds, a trace from action to rule to state, a bounded rule editor, baseline-versus-revised comparison
- the integrity rules: synthetic data only, no metric that is not calculated, escalation must never grant approval, no claims of real impact
- the visual direction, the accessibility requirements and the completion standard

**Claude**, an AI model made by Anthropic, working from that specification:

- chose the implementation design (browser-only, pure-function engine, single-file build)
- wrote the TypeScript engine, interface, tests, build scripts and browser check
- wrote the first draft of all documentation
- chose the fictional company, scenario data and specific rule options

Commits written by Claude carry a `Co-Authored-By: Claude` trailer.

## Before this is published

This section is for Jon to complete truthfully. Leave a line out if it did not happen.

- [ ] I ran `npm run verify` and `npm run test:browser` myself and saw them pass.
- [ ] I read `machine.ts` and can explain every transition and the guard.
- [ ] I completed the prediction exercise and recorded where my predictions were wrong.
- [ ] I made these changes myself: _(list commits, or write "none yet")_
- [ ] I reviewed every sentence on the "Inside the project" page and it is accurate.

## How to describe it

Accurate: "I specified and directed an AI-assisted build of a workflow simulation, and I can explain how it works and why."

Not accurate: "I built", "I coded" or "I wrote" the engine, unless and until Jon has written a meaningful part of it.
