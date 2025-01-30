# Reported & Untreated bugs

When watching a variable, you can only watch 1 instance of the same variable. Thus, if you watch a range `foo[2:4]`
you can't also watch `foo[4:9]`, only one of them will be shown. This will be fixed in future releases.
