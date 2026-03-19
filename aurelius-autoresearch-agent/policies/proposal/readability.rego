# Readability Policy
package proposal.readability

import rego.v1

default allow := true

score := 75 if {
  input.content
} else := 0

reason := sprintf("Readability score: %d", [score])
