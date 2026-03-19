# Safety Constraints
#
# Enforces safety guardrails on autonomous operations to prevent
# unintended destructive actions, data exfiltration, and resource
# exhaustion. Applied as a pre-flight check before any operation.
#
# Input schema:
#   input.operation    - the operation being requested
#   input.source       - requesting entity (panel ID or system)
#   input.target       - target resource or system
#   input.parameters   - operation-specific parameters

package constraints.safety

import rego.v1

default allow := false
default deny := false

# Operations that are always blocked regardless of context
blocked_operations := {
	"delete_all_artifacts",
	"reset_system",
	"bypass_policy",
	"disable_audit_log",
	"modify_governor",
	"export_credentials",
	"access_host_filesystem",
}

# Check operation is not in blocked list
not_blocked if {
	not input.operation in blocked_operations
}

# Rate limiting: prevent excessive operations in short timeframes
rate_limit_ok if {
	not input.parameters.requests_last_minute
} else if {
	input.parameters.requests_last_minute <= 100
}

# Resource limits: prevent sandbox resource abuse
resource_limits_ok if {
	not input.parameters.memory_mb
} else if {
	input.parameters.memory_mb <= 4096
}

resource_limits_ok if {
	not input.parameters.cpu_cores
} else if {
	input.parameters.cpu_cores <= 4
}

# Network access restrictions for sandboxes
network_ok if {
	input.operation != "create_sandbox"
} else if {
	not input.parameters.network_access
} else if {
	input.parameters.network_access == true
	input.parameters.network_allowlist != null
	count(input.parameters.network_allowlist) > 0
}

# Data exfiltration prevention
no_exfiltration if {
	not input.parameters.destination
} else if {
	not startswith(input.parameters.destination, "http")
} else if {
	input.parameters.destination_approved == true
}

# Prevent operations on system-critical paths
safe_target if {
	not input.target
} else if {
	not startswith(input.target, "/etc")
	not startswith(input.target, "/sys")
	not startswith(input.target, "/proc")
	not startswith(input.target, "/root")
}

allow if {
	not_blocked
	rate_limit_ok
	resource_limits_ok
	network_ok
	no_exfiltration
	safe_target
}

deny if {
	not not_blocked
}

reason := sprintf("Operation '%v' is permanently blocked", [input.operation]) if {
	not not_blocked
} else := "Rate limit exceeded" if {
	not rate_limit_ok
} else := "Resource limits exceeded" if {
	not resource_limits_ok
} else := "Network access requires an allowlist" if {
	not network_ok
} else := "Potential data exfiltration detected" if {
	not no_exfiltration
} else := "Unsafe target path" if {
	not safe_target
} else := "Safe"

findings := {
	"allow": allow,
	"deny": deny,
	"reason": reason,
	"operation": input.operation,
	"source": input.source,
}
