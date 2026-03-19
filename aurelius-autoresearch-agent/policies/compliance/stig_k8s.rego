# DISA STIG for Kubernetes
#
# Evaluates Kubernetes cluster configurations against DISA Security Technical
# Implementation Guide (STIG) requirements. Checks API server, etcd, kubelet,
# and network policy configurations.
#
# Input schema:
#   input.api_server      - API server configuration object
#   input.etcd            - etcd configuration object
#   input.kubelet         - kubelet configuration object
#   input.network_policy  - network policy configuration object
#   input.pod_security    - pod security standards configuration

package compliance.stig_k8s

import rego.v1

default allow := false

# V-242381: API server must use TLS 1.2+
api_tls_valid if {
	input.api_server.tls_min_version in {"VersionTLS12", "VersionTLS13"}
}

# V-242382: API server must have audit logging enabled
audit_logging_enabled if {
	input.api_server.audit_log_path != ""
	input.api_server.audit_log_maxage >= 30
}

# V-242383: etcd must use TLS for peer communication
etcd_peer_tls if {
	input.etcd.peer_cert_file != ""
	input.etcd.peer_key_file != ""
}

# V-242384: kubelet must have anonymous authentication disabled
kubelet_auth_secure if {
	input.kubelet.anonymous_auth == false
	input.kubelet.authorization_mode == "Webhook"
}

# V-242385: Network policies must be defined
network_policies_exist if {
	count(input.network_policy.policies) > 0
}

# V-242386: Pod security standards must be enforced
pod_security_enforced if {
	input.pod_security.enforce in {"baseline", "restricted"}
}

# Aggregate all checks
checks := {
	"api_tls_valid": api_tls_valid,
	"audit_logging_enabled": audit_logging_enabled,
	"etcd_peer_tls": etcd_peer_tls,
	"kubelet_auth_secure": kubelet_auth_secure,
	"network_policies_exist": network_policies_exist,
	"pod_security_enforced": pod_security_enforced,
}

total_controls := count(checks)

passing_controls := count({name |
	some name, result in checks
	result == true
})

score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

allow if {
	score >= 85
}

findings := {
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"score": score,
	"checks": checks,
}
