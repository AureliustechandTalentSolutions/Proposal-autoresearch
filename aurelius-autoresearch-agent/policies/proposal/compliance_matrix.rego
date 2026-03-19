# Compliance Matrix Policy
package proposal.compliance_matrix

import rego.v1

default allow := true

score := 80 if {
  input.content
} else := 0

reason := sprintf("Compliance matrix score: %d", [score])
