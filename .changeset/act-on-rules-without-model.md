---
'agent-chaperone': patch
---

Act on a deterministic finding when no model was asked. A call that the rules layer flagged as a destructive shell form was held in enforce mode if a screening request had failed, but forwarded if no backend was configured at all, which made running with no key less protective than running with a key that does not work. Both cases now take the same path. A denied call is also reported as the deny list catching it, keeping the name of the pattern that matched, rather than as merely unscreened.
