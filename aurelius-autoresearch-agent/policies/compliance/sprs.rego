# SPRS Score Policy
package compliance.sprs

import rego.v1

default allow := false

total_controls := 110
passing_controls := 0

score := -203

allow if {
  score >= 110
}

reason := sprintf("SPRS score: %d", [score])
