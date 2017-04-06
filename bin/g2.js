#!/usr/bin/env node

/* eslint camelcase: "off" */

// This is (going to be) the node script we use to test g2 boards in production.

let G2coreAPI = require('../');
let util = require('util');
let fs = require('fs');
let readline = require('readline');
let chalk = require('chalk');
let sprintf = require('sprintf-js').sprintf;

let rl = null; // placeholder for readline object

let STAT_CODES = {
  0: 'Init',
  1: 'Ready',
  2: 'ALARM',
  3: 'Stop',
  4: 'Ended',
  5: 'Running',
  6: 'Hold',
  7: 'Probing',
  8: 'Running Cycle',
  9: 'Homing',
};

let args = require('yargs')
  // .command(['send <gcode>', '* <gcode>'], 'send a gcode file', {
  //   desc: 'Gcode file to run. If omitted, an interactive interface will be ' +
  //         'presented.',
  // })
  .option('port', {
    alias: 'p',
    desc: 'Name of serial port. Use -l to see the available ports. If omitted '+
          'then `g2` will attempt to auto-detect a g2core device over USB.',
  })
  .option('dataport', {
    alias: 'd',
    desc: 'Name of data serial port. Use -l to see the available ports. A ' +
          'value for -p must be provided if -d is provided.',
  })
  .option('log_default', {
    alias: 'L',
    boolean: true,
    desc: 'Name of file to log to. Piping STDERR to a file will do the same ' +
          'thing (and trump this option).',
  })
  .option('log', {
    alias: 'g',
    desc: 'Name of file to log to. Piping STDERR to a file will do the same ' +
          'thing (and trump this option).',
  })
  .option('list', {
    alias: 'l',
    flag: true,
    desc: 'Name of data serial port. Use -l to see the available ports.',
  })
  .option('init', {
    alias: 'i',
    desc: 'Optional path of a JSON file containing the initial settings to ' +
          'pass to the g2core device after connection. If opmitted, then it ' +
          ' will use the first of `./g2-core` or `/.g2-core` that is found, ' +
          'or nothing.',
  })
  .option('timed', {
    alias: 'T',
    boolean: true,
    desc: 'Read the incoming file looking for timecodes at the beginning of ' +
          'lines and use that for sending (FOR TESTING ONLY)',
  })
  .option('checksum', {
    alias: 'c',
    boolean: true,
    desc: 'Send using checksums and sequential line numbers. ' +
          'ONLY FOR FIRMWARES THAT SUPPORT IT.',
  })
  .help('help')
  .alias('help', 'h')
  .argv;

let g = new G2coreAPI();
let logStream = process.stderr; // We may change this later
let startTime = new Date();

// Interactive means that we're not just showing a progress bar but are
// presenting a full console.
let interactive = process.stdout.isTTY && process.stdin.isTTY;
let sendingFile = false;
let latestMotionStatus = 0;

if (args.log_default && args._[0] && !args.log) {
  args.log = args._[0] + '.log';
}

if (args.log) {
  logStream = fs.createWriteStream(args.log, {flags: 'a'});
  logStream.write(`## Opened log: ${startTime.toLocaleString()}\n`);
}

/**
 * log - only logs if output is NOT stderr
 * @param  {string} x data to log
 */
function log(x) {
  if (logStream !== process.stderr) {
    logStream.write(x);
  }
}

/**
 * log_c - log to console if interactive
 * @param  {string} x the data to log
 */
function log_c(x) {
  if (interactive) {
    if (!x.match(/\n$/)) {
      x = x + '\n';
    }
    process.stdout.write(x);
  }
}

g.on('error', function(err) {
  log(err+'\n');
  log(util.inspect(err.data)+'\n');
});

if (args.list) {
  g.list().then(function(results) {
    for (let i = 0; i < results.length; i++) {
      let item = results[i];
      log_c(util.inspect(item));
    }

    if (results.length === 0) {
      no_g2_Found();
      process.exit(0);
    }
  }).catch(function(e) {
 throw e;
});
} else {
  openg2();
}

/**
 * no_g2_Found - internal use only
 */
function no_g2_Found() {
  log_c('No g2s were found. (Is it connected and drivers are installed?)');
}

// promisify fs.readFile()
/**
 * readFile promisify fs.readFile()
 * @param  {string} filename path to the file to read
 * @return {Promise}          promise to be fulfilled when the file is read
 */
function readFile(filename) {
    return new Promise(function(resolve, reject) {
        fs.readFile(filename, function(err, buffer) {
            if (err) reject(err);
            else resolve(buffer);
        });
    });
}

/**
 * parseCommand parse a commmand-line command
 * @param  {string} line the command
 */
function parseCommand(line) {
  if (interactive) {
    // all commands start with a ., or are single-letter on a line...
    let cmd_in = line.match(/^\s*\.([a-z]+)(?:\s+(.*))?\s*$/i);
    if (cmd_in) {
      let cmd = cmd_in[1].toLowerCase();
      let args = cmd_in[2];

      log_c(util.format('Got cmd \'%s\' and args \'%s\'', cmd, args));

      if (cmd.match(/^q(uit)?$/)) {
        let e = util.format('## Received QUIT command in State \'%s\' -- ' +
                            'sending CTRL-D and exiting.\n',
                            STAT_CODES[latestMotionStatus]
                           );
        log(e);
        process.stdout.write(chalk.dim(e));
        tryToQuit();
      } else if (cmd.match(/^s(end)?$/)) {
        if (sendingFile) {
          process.stdout.write(chalk.red('Unable to send a file -- ' +
                                         'already sending a file.')+'\n');
        } else {
          process.stdout.write(chalk.dim('Send file: ' + args)+'\n');
          sendFile(args);
        }
      } else if (cmd.match(/^k(ill)?$/)) {
        if (sendingFile) {
          process.stdout.write(chalk.red('KILL: Stopping send file.')+'\n');
          g.flush();
          // sendFile callback will clear sendingFile for us.
        } else {
          process.stdout.write(chalk.dim('Cannot stop sending file: not ' +
                                         'sending a file.\n'));
        }
      }

      return;
    }
  }

  log(`>${line}\n`);
  g.write(line);
  if (interactive) {
    log_c(chalk.dim(`>${line}`)+'\n');
  }
}

/**
 * tryToQuit internal use only
 */
function tryToQuit() {
  // TODO: verify that we are sending a file

  if (STAT_CODES[latestMotionStatus].match(/^(Run|Probing$|Homing$)/)) {
    g.write('!');
    return;
  } else {
    // if (STAT_CODES[latestMotionStatus].match(/^(Hold|Init|Stop|End|Ready)$/))
    // g.write('\x04'); // send the ^d
    if (rl !== null) {
      rl.close();
      // rl = null;
    }

    g.close();

    return;
  }
}

let maxLineNumber = 0;
/**
 * sendFile send a file
 * @param  {string} fileName     path to the file
 * @param  {bool} exitWhenDone exit the program when sending is done
 */
function sendFile(fileName, exitWhenDone) {
  if (exitWhenDone === null) {
    exitWhenDone = false;
  }

  /**
   * startSendFile internal function to begin the sending process
   */
  function startSendFile() {
    sendingFile = true;
    g.sendFile(fileName || process.stdin, function(err) {
      if (err) {
        log(util.format('Error returned: %s\n', util.inspect(err)));
      }
      log(util.format('### Done sending\n'));
      log_c(util.format('### Done sending\n'));
      process.stdout.write('\n');

      sendingFile = false;
      maxLineNumber = 0;

      // log("closing...");
      if (exitWhenDone === true) {
        if (rl !== null) {
          rl.close();
          rl = null;

          g.close();
        }
      }
    });
  }

  if (fileName) {
    let readStream = fs.createReadStream(fileName);
    readStream.once('open', function() {
      maxLineNumber = 0;

      let readBuffer = '';

      readStream.setEncoding('utf8');

      readStream.once('end', function() {
        readStream.close();
      });

      readStream.once('close', function() {
        startSendFile();
      });

      readStream.on('data', function(data) {
        readBuffer += data.toString();

        // Split collected data by line endings
        let lines = readBuffer.split(/(\r\n|\r|\n)+/);

        // If there is leftover data,
        readBuffer = lines.pop();

        lines.forEach(function(line) {
          if (line.match(/^(?:[nN][0-9]+\s*)?(.*)$/))
            return;

          maxLineNumber++;
        });
      });
    });

    readStream.on('error', function(e) {

    });
  } else {
    startSendFile();
  }
}

/**
 * openg2 - open the g2core machines - this is the main function
 */
function openg2() {
  if (!args.port) {
    g.openFirst(/* fail if multiple:*/ true, {
      timedSendsOnly: args.timed,
      useChecksums: args.checksum,
    });
  } else {
    g.open(args.port, {
      dataPortPath: args.dataport,
      timedSendsOnly: args.timed,
      useChecksums: args.checksum,
    });
  }

  g.on('open', function() {
    // console.log('#### open');

    /**
     * completeOpen - internal use only
     */
    function completeOpen() {
      if (process.stdout.isTTY) {
        rl = readline.createInterface(process.stdin, process.stdout);
        rl.setPrompt(chalk.dim('g2# '), 'g2# '.length);
        rl.prompt();

        // WARNING WARNING WARNING -- using the internals of node readline!!
        //
        // We need to override the default behavior for a few keys.
        // So, we tell stdin to REMOVE all of the listeners to the 'keypress'
        // event, then we will be the only listener. If we don't have a special
        // behavior for the pressed key, then we pass it on to the readline.
        //
        // To avoid using internals too much, we'll snarf in the listeners,
        // store them away, and then call them ourselves.
        let old_keypress_listeners = process.stdin.listeners('keypress');

        process.stdin.removeAllListeners('keypress');
        process.stdin.on('keypress', function(ch, k) {
          if (k && k.ctrl) {
            if (k.name == 'd') {
              if (sendingFile) {
                log(util.format('>>^d\n'));
                g.write('\x04'); // send the ^d
              }
              return;
            } else if (k.name == 'c') {
              let e = util.format('## Received CTRL-C in State \'%s\' -- ' +
                                  'sending CTRL-D and exiting.\n',
                                  STAT_CODES[latestMotionStatus]
                                );
              log(e);
              if (interactive) {
                process.stdout.write(chalk.dim(e));
              }

              tryToQuit();
              return;
            }

          // Single character commands get sent immediately
        } else if (ch && ch.match(/^[!~%]/)) {
            log(util.format('>>%s\n', ch));
            g.write(ch);
            return;
          }

          for (let i = 0; i < old_keypress_listeners.length; i++) {
            old_keypress_listeners[i](ch, k);
          }
        });

        rl.on('line', function(line) {
          parseCommand(line);
          if (rl !== null) {
            rl.prompt(true);
          }
        });

        rl.on('close', function() {
          g.close();
          rl = null;
        });

        let leftText = 'Progress |';
        let rightText = '|   0% ';

        let status = {};

        g.on('statusChanged', function(st) {
          for (let prop in st) {
            if ({}.hasOwnProperty.call(st, prop)) {
              status[prop] = st[prop];
            }
          }

          if (status.stat) {
            latestMotionStatus = status.stat;
          }

          if (interactive) {
            readline.moveCursor(process.stdout, 0, -1);
            readline.clearLine(process.stdout, 0);

            process.stdout.write(
              sprintf('\rPos: X=%4.2f Y=%4.2f Z=%4.2f A=%4.2f Vel:%4.2f',
                status.posx||0,
                status.posy||0,
                status.posz||0,
                status.posa||0,
                status.vel||0
              )
            );
            if (status.he1t > 0) {
              process.stdout.write(
                sprintf(' He1=%4.1fºC/%4.1fºC',
                  status.he1t||0,
                  status.he1st||0
                )
              );
              if (status.he1op !== undefined) {
                process.stdout.write(
                  sprintf('(%3.0f%%)',
                    status.he1op*100
                  )
                );
              }
            }
            if (status.he2t > 0) {
              process.stdout.write(
                sprintf(' He2=%4.1fºC/%4.1fºC',
                  status.he2t||0,
                  status.he2st||0
                )
              );
              if (status.he2op !== undefined) {
                process.stdout.write(
                  sprintf('(%3.0f%%)',
                    status.he2op*100
                  )
                );
              }
            }
            if (status.he3t > 0) {
              process.stdout.write(
                sprintf(' He2=%4.1fºC/%4.1fºC',
                  status.he3t||0,
                  status.he3st||0
                )
              );
              if (status.he3op !== undefined) {
                process.stdout.write(
                  sprintf('(%3.0f%%)',
                    status.he3op*100
                  )
                );
              }
            }
            process.stdout.write(
              sprintf(' (%s)\n',
                STAT_CODES[status.stat] || 'Stopped'
              )
            );

            if (!sendingFile) {
              process.stdout.write(
                JSON.stringify(status, null, 0) + '\n'
              );

              rl.prompt(true);
            }
          }


          if (st.line && sendingFile) {
            if (st.line > maxLineNumber) {
              maxLineNumber = st.line;
            }
            // clear the whole line.
            // readline.moveCursor(process.stdout, 0, -1);
            // readline.clearLine(process.stdout, 0);
            process.stdout.write('\r');

            let maxWidth = process.stdout.columns;
            let paddingWidth = leftText.length + rightText.length;
            let barWidth = (maxWidth - paddingWidth) * (st.line/maxLineNumber);
            let barLeft = (maxWidth - paddingWidth);

            process.stdout.write(leftText);
            while (barWidth > 1.0) {
              process.stdout.write('=');
              barWidth = barWidth - 1.0;
              barLeft--;
            }
            if (barWidth > 0.6) {
              process.stdout.write('+');
              barLeft--;
            } else if (barWidth > 0.3) {
              process.stdout.write('-');
              barLeft--;
            }
            while (barLeft-- > 0) {
              process.stdout.write('_');
            }

            process.stdout.write('| ');
            let percent = ((st.line/maxLineNumber) * 100);
            process.stdout.write(sprintf('%3.0f%%', percent));

            // if (process.stderr.isTTY) {
            //   process.stdout.write("\n")
            // } else {
              process.stdout.write('\r');
            // }
          } // if st.line
          // rl.prompt(true);
        }); // g.on('statusChanged', ... )
      }

      if (args._[0] || !process.stdin.isTTY) {
        sendFile(args._[0] || process.stdin, true);
      }
    }

    if (args.init) {
      readFile(args.init, 'utf-8')
      .then(function(text) {
        return g.set(JSON.parse(text));
      }).then(function() {
        completeOpen();
      });
    } else {
      completeOpen();
    }

    g.on('data', function(data) {
      log(util.format('[[<%d]]%s\n', Date.now(), data.replace(/\n+/, '\n')));
    });

    // g.on('doneSending', function(data) {
    //   g.close();
    // });

    g.on('sentRaw', function(data, channel) {
      log(util.format('[[%s%d]]%s', channel, Date.now(),
          data.replace(/\n+/g, '\n') ));
    });

    g.on('close', function() {
      // clearInterval(srBlaster);
      log(util.format('### Port Closed!!\n'));

      if (args.log) {
        // TODO: Use startTime to determine length of job run
        log('## Closing log: ' + (new Date()).toLocaleString() + '\n\n');
        // logStream.close();
      }

      // process.exit(0);
    });
  });
}
