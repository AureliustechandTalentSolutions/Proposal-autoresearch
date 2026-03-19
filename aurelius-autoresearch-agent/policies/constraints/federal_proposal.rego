# Federal Proposal Constraints
package constraints.federal_proposal

import rego.v1

default allow := true

deny if {
  input.operation == "export_package"
  object.get(input, "proposal", {})
  input.proposal.volume_count == 0
}

allow if {
  not deny
}

reason := "Federal proposal constraint check" if { allow }
reason := "Cannot export package with zero volumes" if { deny }
