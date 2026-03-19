# Safety Constraints
# Prevents modifications that exceed size thresholds or target protected areas.
package constraints.safety

import rego.v1

default allow := true

max_delta_chars := 50000

deny if {
  input.operation == "modify_artifact"
  params := object.get(input, "parameters", {})
  delta := object.get(params, "delta_chars", 0)
  delta > max_delta_chars
}

allow if {
  not deny
}

reason := "Safety constraints satisfied" if { allow }
reason := sprintf("Modification exceeds maximum delta of %d characters", [max_delta_chars]) if { deny }
