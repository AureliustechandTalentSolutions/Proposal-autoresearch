# Proposal Page Limits Policy
#
# Enforces page limit constraints defined in solicitation instructions.
# Validates that each volume and section stays within prescribed limits,
# accounting for font size, margins, and spacing requirements.
#
# Input schema:
#   input.volumes       - array of volume objects with page counts
#   input.solicitation  - solicitation constraints (page limits, formatting)
#   input.formatting    - actual formatting measurements

package proposal.page_limits

import rego.v1

default allow := false

# Check each volume against its page limit
volume_compliance := {vol.name: compliant |
	some vol in input.volumes
	limit := input.solicitation.page_limits[vol.name]
	compliant := vol.page_count <= limit
}

# Total pages across all volumes
total_pages := sum({vol.page_count | some vol in input.volumes})

# Total page limit
total_limit := sum({limit | some _, limit in input.solicitation.page_limits})

# Check formatting compliance
font_ok if {
	input.formatting.font_size >= input.solicitation.min_font_size
}

margin_ok if {
	input.formatting.margin_top >= input.solicitation.min_margin
	input.formatting.margin_bottom >= input.solicitation.min_margin
	input.formatting.margin_left >= input.solicitation.min_margin
	input.formatting.margin_right >= input.solicitation.min_margin
}

spacing_ok if {
	input.formatting.line_spacing >= input.solicitation.min_line_spacing
}

# All volumes must be within limits
all_volumes_compliant if {
	every name, compliant in volume_compliance {
		compliant == true
	}
}

# Overall compliance
allow if {
	all_volumes_compliant
	font_ok
	margin_ok
	spacing_ok
}

# Identify over-limit volumes
over_limit_volumes := {name: excess |
	some name, compliant in volume_compliance
	not compliant
	some vol in input.volumes
	vol.name == name
	limit := input.solicitation.page_limits[name]
	excess := vol.page_count - limit
}

total_controls := 4 # volumes + font + margins + spacing

passing_controls := count({check |
	checks := [all_volumes_compliant, font_ok, margin_ok, spacing_ok]
	some check in checks
	check == true
})

score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

findings := {
	"total_pages": total_pages,
	"total_limit": total_limit,
	"volume_compliance": volume_compliance,
	"over_limit_volumes": over_limit_volumes,
	"font_ok": font_ok,
	"margin_ok": margin_ok,
	"spacing_ok": spacing_ok,
	"score": score,
	"total_controls": total_controls,
	"passing_controls": passing_controls,
}
