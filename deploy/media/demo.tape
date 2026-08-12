# vhs tape — the README-top demo GIF.
# Record ONLY against a published version (D4 discipline):
#   vhs deploy/media/demo.tape
# Produces deploy/media/demo.gif (target < 5MB).

Output deploy/media/demo.gif

Set FontSize 13
Set Width 1180
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 12

# demo pacing: fewer tasks → tighter GIF (three acts still land)
Hide
Type "export ANTLEGION_DEMO_TASKS=120 NO_COLOR="
Enter
Type "clear"
Enter
Show

Type "npx @antlegion/bus demo"
Sleep 500ms
Enter

# ACT 1 (race) + ACT 2 (crash) + ACT 3 (replay) ≈ 12-16s, then verdict
Sleep 24s
