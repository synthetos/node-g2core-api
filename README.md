<img src="https://raw.githubusercontent.com/wiki/synthetos/g2/images/g2core.png" width="300" height="129" alt="g2core">

# g2core-api


g2core-api is a node library module (`g2core-api`) and a bundled commmand-line utility (`g2`) to abstract communications and control of a device running [Synthetos g2core](https://github.com/synthetos/g2) firmware. Written and maintained by the [Synthetos](http://synthetos.com) core team.

# Usage as a library

```javascript
// Require "g2core-api" to get access to the G2coreAPI class
const G2coreAPI = require("g2core-api");

// Then create a g2core_api object, we'll call it 'g2' in our examples
var g2 = new G2coreAPI();
```

Now you have a `g2` object, you need to tell it to connect to a g2core device, then you can interact with that device.

See [./docs/ReadMe.adoc](./docs/ReadMe.adoc) for more documentation


# Usage as a command line utility

*Note: This is for advanced users and is experimental.*

First install the `g2core-api` npm globally, so the `g2` command will be in your path:

```bash
  # NOTE: You may need to use sudo or log in as root
  npm install -g g2core-api
```

Now you can just execute the `g2` command to get a full "terminal" experience to g2core device.

Or, if you have already `g2core-api` installed and in your local `node_modules`, you can refer to it as `node_modules/.bin/g2` instead.

If there is only one g2core device attached over USB, then you don't need to provide any more parameters:

```
  my_host$ g2
  Pos: X=0.00 Y=0.00 Z=0.00 A=0.00 Vel:0.00 (Ended)
  g2core# g0x10
  Pos: X=10.00 Y=0.00 Z=0.00 A=0.00 Vel:0.00 (Stop)
  g2core# ^C
```

Note: Use `Ctrl-C` to exit.

To send a file with the `g2` utility, simply pass the filename of a gcode file, and it'll give you interactive progress bar:

```
  my_host$ g2 my_awesome_project.gcode
  Found command port: '/dev/cu.usbmodem14521' with data port '/dev/cu.usbmodem14523'.
  g2core# Opening file 'my_awesome_project.gcode' for streaming.
  Progress |=========================================================______|  91%
```

If you wish to keep a log of the interaction between the g2core and the `g2` utility, then add the `-L` option to make a log file next to the gcode filename with `.log` added to the name, *or* `-g LOGFILE` parameter to have it save the log in `LOGFILE`.

```
  my_host$ g2 my_awesome_project.gcode -L
  Found command port: '/dev/cu.usbmodem14521' with data port '/dev/cu.usbmodem14523'.
  Opening file 'my_awesome_project.gcode' for streaming.
  Progress |=========================================================______|  91%
```

_Note: The `g2` command line utility is still a little rough around the edges. It's still in active development, so update often!_

## `g2(1)` usage

```bash
Usage: g2 [gcode] [options]

gcode     Gcode file to run

Options:
   -p PORT, --port PORT        Name of serial port. Use -l to see the available
                                  ports. If omitted then it will attempt to
                                  auto-detect a g2core device over USB.
   -d PORT, --dataport PORT    Name of data-only serial port (optional).
                                  Use -l to see the available ports.
   -L                          Make or add to a a log file next to the gcode
                                  file with '.log' added to the filename.
   -g LOGFILE, --log LOGFILE   Log to LOGFILE.
                                  The last -L or -g will be honored.
   -l, --list                  List the available ports that can be detected.
                                  Note that this only lists USB devices.
   -v                          Raise the verbosity level of the command line.
                                  (Does not effect logging to file, which is
                                  always at full verbosity.)
```
