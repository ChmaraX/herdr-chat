# fake-hc

Stands in for `hc get <terminal> --json`, which the host's hand-off watch polls
(the host runs `$PI_CHAT_HC`, default `hc`). A terminal is
`$FAKE_HC_DIR/<address>.json`, holding what `hc get` would print, such as
`{"state":"live"}` or `{"state":"finished"}`. Without that file it prints
hc's `not_found` error and exits 3, like a terminal that was killed and
cleaned up.

It also takes `hc label <terminal> k=v…` (what the sub-agent launcher runs on
its own terminal): each call is a JSON line `{terminal, labels}` in
`$FAKE_HC_DIR/label.log`. `FAKE_HC_LABEL_FAIL=1` makes it exit 1.
