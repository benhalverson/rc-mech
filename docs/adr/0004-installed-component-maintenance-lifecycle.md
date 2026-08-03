# Follow maintenance plans on installed component instances

**Status:** accepted

Maintenance plans belong to installed component instances rather than only to component slots or car models. Replacing a component resets its plan baseline; removing it pauses the plan, and replacing it reattaches and resumes the plan. This preserves useful service history and prevents usage accrued by an old component from making a new component appear overdue, at the cost of retaining lifecycle state for replacements.
