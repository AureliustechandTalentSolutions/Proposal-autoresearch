# STIG Kubernetes Compliance Policy
package compliance.stig_k8s

import rego.v1

default allow := false

total_controls := 50
passing_controls := 0

score := 0

allow if {
  score >= 70
}

reason := "STIG K8s evaluation pending"
