CHURCH KIT — run the Wing session without any dev tools
=========================================================

Each numbered .bat file is one step. Double-click them IN ORDER.
A window opens, does its thing, and waits for a key press so you can
read the output. Full details for every step (including rollback
instructions) are in docs\CHURCH_SESSION.md — this folder is just the
"don't make me type commands" version of that document.

GETTING THIS ONTO THE CHURCH PC
-------------------------------
Now that the repo is on GitHub (kelcydeeds-wq/wing-toolkit, private), the
easiest way is a git clone/pull on the church PC — no USB stick needed:
  git clone https://github.com/kelcydeeds-wq/wing-toolkit.git
  (or, if it's already cloned there: git pull)
Then cd into wing-brain and run 0-FIRST-TIME-SETUP.bat as below.

If the church PC has no internet access or no git installed, fall back to
the USB method:
1. Copy the whole "wing-brain" folder to a USB stick.
   (You can skip the "node_modules" folder — step 0 rebuilds it.)
2. On the church PC, copy it somewhere like C:\wing-brain.
3. If the church PC doesn't have Node.js: install the LTS version
   from https://nodejs.org (all defaults are fine). Step 0 checks this.

THE SEQUENCE
------------
  0-FIRST-TIME-SETUP.bat      Once per PC. Checks Node, installs
                              dependencies, runs the test suite.

  1-SELFTEST-MOCK.bat         Optional but smart: run this AT HOME
                              before you go. Exercises the whole
                              dump -> plan -> apply chain against the
                              built-in mock console. If this passes,
                              the software side is healthy.

  1b-LIST-AUDIO-DEVICES.bat   Optional. Lists every audio device Windows
                              sees on this PC -- run it to find the
                              Wing's USB audio interface (or SoundGrid
                              once installed) before trying step 6's
                              live measurement. READ-ONLY.

  --- at the church, in order ---

  (MANUAL, NO SCRIPT)         FIRST: full Wing scene/show backup to
                              USB, on the console itself. Reload it to
                              prove it's readable. Do NOT skip this.
                              This is the rollback for everything.

  2-DUMP-WING-STATE.bat       Reads the whole console state over the
                              network into a JSON file. Asks for the
                              Wing's IP the first time (remembers it).
                              READ-ONLY — touches nothing.
                              * If it says 0 addresses answered, the
                                OSC address guesses are wrong. Expected
                                on the very first real run — stop after
                                this step and bring the dump file home
                                so the addresses can be fixed. Nothing
                                is broken and nothing was changed.

  2b-IDENTIFY-OUTPUTS.bat     Optional. Fast read-only check of every
                              main/matrix number's name + mute state --
                              use it to fill in config\default.json's
                              outputs[].wing.num "confirm at audit"
                              TODOs without reading the full dump.

  3-PLAN-REMAP.bat            Builds the channel remap plan from the
                              dump and OPENS THE PLAN IN NOTEPAD.
                              READ IT. Every row is a channel move.
                              Wrong bucket? Note it — you can hand-edit
                              the .remap.json file it names.
                              READ-ONLY — touches nothing.

  4-APPLY-REMAP-DRYRUN.bat    Shows exactly what the remap WOULD do,
                              without writing anything. Check that
                              each channel reads a sensible number of
                              source parameters (not 0/91).

  5-APPLY-REMAP-EXECUTE.bat   THE ONLY DESTRUCTIVE STEP. Writes the
                              channel moves to the console, verifying
                              each one. Makes you type YES first.
                              Only run after 4 looked right and the
                              USB backup from the manual step exists.

  6-START-TUNING-APP.bat      Starts the tuning app. Open the address
                              it prints on your phone (church WiFi).
                              Use the gear (⚙) icon to switch to live
                              mode + set the Wing IP, then run a
                              Pre-flight Check before any Full Tune.
                              Leave this window open while using the
                              app; close it to stop the server.

  7-RECORD-REHEARSAL.bat      Start before rehearsal, press Ctrl+C to
                              stop after. Captures console OSC traffic
                              to a file for later development. Safe,
                              read-only.

  (MANUAL, NO SCRIPT)         LAST: save the new scene as baseline on
                              the console + fresh USB backup, and copy
                              the whole "data" folder off this PC.

NOTES
-----
- The Wing's IP is asked once and saved to wing-ip.txt in this folder.
  Delete that file to be asked again.
- A full measurement tune (step 6) also needs the measurement mic and
  a 2-input audio interface on THIS pc, plus sox installed. Without
  those, step 6 still runs fine in mock mode for demo/training.
- If any window flashes an error and closes too fast, run it again —
  every script ends with "press any key" so output should stay up.
