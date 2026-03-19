# Page Limits Policy
package proposal.page_limits

import rego.v1

default allow := true

page_limit := object.get(input, "page_limit", 100)
estimated_pages := object.get(input, "estimated_pages", 0)

score := 100 if {
  estimated_pages <= page_limit
} else := 50

allow if {
  estimated_pages <= page_limit
}

reason := sprintf("Pages: %d / %d limit", [estimated_pages, page_limit])
