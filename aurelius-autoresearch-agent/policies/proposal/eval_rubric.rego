# Proposal Evaluation Rubric Policy
package proposal.eval_rubric

import rego.v1

default allow := true

score := 50 if {
  not input.content
} else := calculated_score

calculated_score := min([100, base]) if {
  content := input.content
  base := 40
}

reason := sprintf("Rubric score: %d", [score])
