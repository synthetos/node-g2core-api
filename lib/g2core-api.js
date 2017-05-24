/* eslint guard-for-in: "warn" */
'use strict';

let EventEmitter = require('events').EventEmitter;
let util = require('util');
let fs = require('fs');
let SerialPort = require('serialport');

let VALID_CMD_LETTERS = ['m', 'g', 't'];


/**
 * G2Error - description
 *
 * @param  {type} subname description
 * @param  {type} message description
 * @param  {type} data    description
 */
function G2Error(subname, message, data) {
  Error.call(this);
  this.name = 'G2'+subname+'Error';
  this.message = message || 'Raw Data: ' + util.inspect(data, {depth: null});

  this.data = data;
}
util.inherits(G2Error, Error);

/* ** ********************** ** */

/* *** Create the G2coreAPI object *** */

/**
 * G2coreAPI - The primary G2Core class
 *
 */
class G2coreAPI extends EventEmitter {
  /**
   * constructor - G2coreAPI cobnstructor
   */
  constructor() {
    super();

    // predefine
    this.serialPortControl = null;
    this.serialPortData = null;
    this.inHold = false;
    this.linesInBuffer = 0;
    this.timedSendsOnly = false;
    this.doneReading = false;
    this.lineBuffer = []; // start it out ensuring that the machine is reset;
    this.linesRequested = 0; // total number of lines to send,
                             // including this.linesSent
    this.linesSent = 0;      // number of lines that have been sent
    this.lineInLastSR = 0;
    this.ignoredResponses = 0; // Keep track of out-of-band commands to
                               // ignore responses to
    this.setupDone = false;

    this._readBuffer = '';

    this.useChecksums = false;

    this._previousTimecode = {
      timecode: 0,
      lines: 0,
      fired: false, // This is just in case a timeout fires before we've added
                   // all the lines
      // Note: that there's still a race condition, but we're mitigating it.
    };

    this._startTimecode = 0;
    this._startActualTime = 0;

    let self = this;

    /**
     * _g2parser - description
     *
     * @param  {type} emitter description
     * @param  {type} buffer  description
     */
    let _g2parser = (emitter, buffer)=>{
      // Collect data
      this._readBuffer += buffer.toString();

      // Split collected data by line endings
      let parts = this._readBuffer.split(/(\r\n|\r|\n)+/);

      // If there is leftover data,
      this._readBuffer = parts.pop();

      parts.forEach(function(part) {
        // Cleanup and remove blank or all-whitespace lines.
        if (part.match(/^\s*$/))
          return;

        // Remove stray XON/XOFF charaters that make it through the stream.
        part = part.replace(/([\x13\x11])/, '');

        // Mark everything else with a bullet
        // console.log('part: ' + part.replace(/([\x00-\x20])/, '•'));

        self.emit('data', part);

        let jsObject = null;

        if (part[0] === '{' /* make the IDE happy: } */) {
          try {
            jsObject = JSON.parse(part);
          } catch(err) {
            self.emit('error',
              new G2Error('Parser',
                util.format('Unable to parse "%s": %s', part, err),
                {err: err, part: part}
              )
            );
            return;
          }

          // We have to look in r/f for the footer due to a bug in TinyG...
          if (jsObject.hasOwnProperty('r')) {
            let footer = jsObject.f || (jsObject.r && jsObject.r.f);
            if (footer !== undefined) {
              if (footer[1] === 108) {
                self.emit('error', new G2Error(
                  'Response',
                  util.format('G2coreAPI reported an syntax error reading' +
                  ' \'%s\': %d (based on %d bytes read)',
                  JSON.stringify(jsObject.r), footer[1], footer[2]),
                  jsObject
                ));
              } else
              if (footer[1] === 20) {
                self.emit('error', new G2Error(
                  'Response',
                  util.format('G2coreAPI reported an internal error reading' +
                              ' \'%s\': %d (based on %d bytes read)',
                              JSON.stringify(jsObject.r), footer[1], footer[2]),
                  jsObject
                ));
              } else
              if (footer[1] === 202) {
                self.emit('error', new G2Error(
                  'Response',
                  util.format('G2coreAPI reported an TOO SHORT MOVE on line %d',
                              jsObject.r.n),
                  jsObject
                ));
              } else
              if (footer[1] === 204) {
                self.emit('error', new G2Error(
                  'InAlarm',
                  util.format('G2coreAPI reported COMMAND REJECTED BY ALARM' +
                              ' \'%s\'', part),
                  jsObject
                ));
              } else
              if (footer[1] !== 0) {
                self.emit('error', new G2Error(
                  'Response',
                  util.format('G2coreAPI reported an error reading \'%s\':' +
                              '%d (based on %d bytes read)',
                              JSON.stringify(jsObject.r), footer[1], footer[2]
                             ),
                  jsObject
                ));
              }

              // Remove the object so it doesn't get parsed anymore
              // delete jsObject.f;
              // if (jsObject.r) {
              //   delete jsObject.r.f;
              // }
            }

            self.emit('response', jsObject.r, footer);

            jsObject = jsObject.r;
          }

          if (jsObject.hasOwnProperty('er')) {
            self.emit('errorReport', jsObject.er);
          } else
          if (jsObject.hasOwnProperty('sr')) {
            self.emit('statusChanged', jsObject.sr);
          } else
          if (jsObject.hasOwnProperty('gc')) {
            self.emit('gcodeReceived', jsObject.gc);
          }

          if (jsObject.hasOwnProperty('rx')) {
            self.emit('rxReceived', jsObject.rx);
          }
        }
      } // parts.forEach function
      ); // parts.forEach
    }; // _g2parser;

    this._baseOptions = {
      baudRate: 115200,
      rtscts: true,
      // Provide our own custom parser:
      parser: _g2parser,
      timedSendsOnly: false,
    };
  }


  /**
   * open - open a connection to a given g2core device
   *
   * @param  {string} path    path to the serial port device
   * @param  {object} options additional options
   */
  open(path, options) {
    if (this.serialPortControl !== null) {
      this.emit('error',
        new G2Error('Open', 'Unable to open g2 at path \'' + path +
                    '\' -- g2 already open.', {}));
      return;
    }

    this.useChecksums = options['useChecksums'] || false;

    options = options || {};
    for (let key in this._baseOptions) {
      if ({}.hasOwnProperty.call(this._baseOptions, key)) {
        options[key] = options[key] || this._baseOptions[key];
      }
    }

    // console.log(util.inspect(options));
    this.dataPortPath = options.dataPortPath;
    this.timedSendsOnly = options.timedSendsOnly;

    this.serialPortControl = new SerialPort(path, options);

    let _onControlData = (data) => {
      this.emit('data', data);
    };
    this.serialPortControl.on('data', _onControlData);

    let _onOpen = () => {
      // console.error('OPENED '+path);
      process.nextTick(() => {
        this._openSecondChannel(!options.dontSetup);
      });
    };
    this.serialPortControl.once('open', _onOpen);

    let _onControlError = (err) => {
      this.emit('error', new G2Error('SerialPort', util.inspect(err), err));
    };
    this.serialPortControl.on('error', _onControlError);

    this.serialPortControl.once('close', (err) => {
      // console.error('CLOSED '+path);
      if (this.serialPortControl !== null) {
        this.serialPortControl.removeListener('data', _onControlData);
        this.serialPortControl.removeListener('error', _onControlError);
        this.serialPortControl = null;
      }
      this.emit('close', err);
    });
  }; // open


  /**
   * _openSecondChannel - internal only
   *
   * @param  {bool} doSetup
   */
  _openSecondChannel(doSetup) {
    if (this.dataPortPath) {
      this.serialPortData =
        new SerialPort(this.dataPortPath, this._baseOptions);

      let _dataOnData = (data) => {
        // This should NEVER happen!!
        // The data channel should never get data back.
        this.emit('data', data);
      };
      this.serialPortData.on('data', _dataOnData);

      this.serialPortData.once('open', () => {
        // console.error('OPENED2 '+this.dataPortPath);
        this._completeOpen(doSetup);
      });

      let _onDataError = (err) => {
        this.emit('error', {serialPortDataError: err});
      };

      this.serialPortData.on('error', _onDataError);

      this.serialPortData.once('close', (/* err */) => {
        // console.error('CLOSED '+this.dataPortPath);
        this.serialPortData.removeListener('data', _dataOnData);
        this.serialPortData.removeListener('error', _onDataError);
        this.serialPortData = null;
      });
    } else {
      this.serialPortData = null;
      this._completeOpen(doSetup);
    }
  }; // _openSecondChannel

  /**
   * _completeOpen - internal only
   *
   * @param  {bool} doSetup
   */
  _completeOpen(doSetup) {
    let seenConnectionBanner = false;

    // Prepare the event listeners
    let _onResponse = (r) => {
      // console.error('r: '+util.inspect(r));
      if (!seenConnectionBanner) {
        this.emit('connected', r);
        seenConnectionBanner = true;
        this._completeConnection(doSetup);
        return;
      }

      if (r.hasOwnProperty('rx') && this.serialPortData === null) {
        this.ignoredResponses--;
        if (!this.timedSendsOnly) {
          this.linesRequested = r.rx - 1;
        }
        // -1 is okay, that just means wait until we've sent two lines
        // to send again
      } else if (this.ignoredResponses > 0) {
        this.ignoredResponses--;
        return;
      } else {
          if (!this.timedSendsOnly) {
            this.linesRequested++;
          }
      }

      this._sendLines();
    }; // _onResponse
    this.on('response', _onResponse);

    let _onStatusChanged = (sr) => {
      if (sr.line) {
        this.lineInLastSR = sr.line;
      }

      if (!seenConnectionBanner) {
        this.emit('connected', {sr: sr});
        seenConnectionBanner = true;
        this._completeConnection(doSetup);
        return;
      }

      // See https://github.com/synthetos/TinyG/wiki/TinyG-Status-Codes#status-report-enumerations
      //   for more into about stat codes.

      // 3	program stop or no more blocks (M0, M1, M60)
      // 4	program end via M2, M30
      if (sr.stat == 3 || sr.stat == 4) {
        // if (this.doneSending) {
        //   this.emit('doneSending');
        // }

      // 2	machine is in alarm state (shut down)
      } else if (sr.stat == 2) {
        // Fatal error! Shut down!
        // this.emit('doneSending', sr);

      // 6 is holding
      } else if (sr.stat == 6) {
        // pause sending
        // this.lineCountToSend = 0;
        this.inHold = true;

      // 5 is running -- check to make sure we weren't in hold
      } else if (sr.stat == 5 && this.inHold == true) {
        this.inHold = false;

        // request a new rx object to determine how many lines to send
        // this.write({rx:null});
      }
    };  // _onStatusChanged
    this.on('statusChanged', _onStatusChanged);

    // Make sure we clean up when we close...
    this.once('close', () => {
      this.removeListener('response', _onResponse);
      this.removeListener('statusChanged', _onStatusChanged);
    });
}; // _completeOpen


/**
 * _completeConnection - internal only
 *
 * @param  {bool} doSetup
 */
 _completeConnection(doSetup) {
    this.emit('open');
    let setupDone = Promise.resolve(); // eslint-disable-line no-unused-vars

    if (doSetup) {
      setupDone = setupDone
      .then(() => {
        return this.set({sr: null});
      })
      .then(() => {
        return this.set({clr: null});
      })
      .then(() => {
        return this.set({jv: 4}); // Set JSON verbosity to 2 (medium)
      });
    } // if doSetup

    setupDone = setupDone
    .then(() => {
      this.setupDone = true;
      this.emit('setupDone');

      // Allow data to be sent. We'll start with 5 lines to fill the buffer.
      this.linesRequested = 5;
      this._sendLines();
    });
  }; // _completeConnection


  /**
   * _sendLines - internal only
   */
  _sendLines() {
    let lastLineSent = 0;

    // console.log(
    //   util.inspect(
    //   {len: this.lineBuffer.length,
    //    lineCountToSend: (this.linesRequested - this.linesSent),
    //   linesRequested: this.linesRequested, linesSent: this.linesSent}))

    while ((this.lineBuffer.length > 0) &&
           (this.linesRequested - this.linesSent) > 0) {
      let line = this.lineBuffer.shift();
      this._write(line);
      lastLineSent = this.parseGcode(line, {});
      this.linesSent++;
      // console.log("this.lineBuffer.length: " + this.lineBuffer.length)
    }

    if (this.doneReading) {
      // console.log("this.doneReading: " + this.doneReading)
      if (this.lineBuffer.length === 0) {
        this.emit('doneSending');
      }
    } else
    if (this.lineBuffer.length <
          ((this.linesRequested - this.linesSent) + 100)
        ) {
      this.emit('needLines',
        (this.linesRequested - this.linesSent) - this.lineBuffer.length);
    }

    this.emit('sentLine', lastLineSent);
  }; // _sendLines


  /**
   * flush - empty the send buffer, without sending what's left
   */
  flush() {
    // Tell everything else that we're done sending
    this.emit('doneSending', true);

    // Wipe out the line buffer
    this.lineBuffer.length = 0;

    // Reset line requested
    this.linesRequested = 5;

    // Send a queue flush followed by an alarm clear
    this._write('\x04'); // send the ^D
    this._write('{clr:n}');
  }; // flush


  /**
   * close - close the g2core device
   */
  close() {
    // this.emit('error',
    //   util.format('g2core.close(): ',
    //     this.serialPortControl,
    //     this.serialPortData
    //   )
    // );

    if (this.serialPortControl !== null) {
      this.serialPortControl.close();
      // if (this.serialPortData === this.serialPortControl) {
      //   this.serialPortData = null;
      // }
      this.serialPortControl = null;
    }

    if (this.serialPortData !== null) {
      this.serialPortData.close();
      this.serialPortData = null;
    }

    // Empty the send buffer.
    this.lineBuffer.length = 0;
    this.setupDone = false;
  }; // close


  /**
   * write - write value to the channel.
   *
   * @param  {object|string|array} value Write the provided serialized object,
   *                                     array or string to the g2core device.
   *                                     Will intelligently use the correct
   *                                     buffering scheme.
   */
  write(value) {
    if (this.timedSendsOnly && typeof value == 'string') {
      if (timecodeMatch =
         value.match(/^(N[0-9]+\s*)?\[\[([GC])([0-9]+)\]\](.*)/)) {
        let lineNum = timecodeMatch[1] || '';
        let channel = timecodeMatch[2]; // ignored
        let timecode = timecodeMatch[3];
        value = lineNum + timecodeMatch[4];

        let newTimecode = {
          channel: channel,
          timecode: timecode,
          fired: false,
          lines:
            1 + (this._previousTimecode.fired ?
                  this._previousTimecode.lines : 0),
        };

        if (this._startTimecode === 0) {
          this._startTimecode = timecode;
          this._startActualTime = Date.now();
        }

        let delayTime = (
            (newTimecode.timecode - this._startTimecode) -
            (Date.now() - this._startActualTime)
          );
        this._previousTimecode = newTimecode;

        setTimeout(() => {
          this.linesRequested += newTimecode.lines;
          newTimecode.lines = 0;
          newTimecode.fired = true;
          this._sendLines();
        }, delayTime);
      } else {
        this._previousTimecode.lines++;
      }

      // Normally, this would be a terrible idea...,
      // but we're testing, so we do this:
      // replace all the hex-escaped string values with the actual byte value:
      value = value.replace(/\\x([0-9a-fA-F]+)/g,
        function(a, b) {
          return String.fromCharCode(parseInt(b, 16));
        }
      );
    } else

    // Handle getting passed an array
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (v.match(/[\n\r]$/)) {
          v = v + '\n';
        }

        this.lineBuffer.push(v);
      });
      this._sendLines();
      return;
    } else

    // Specials bypass the buffer! Except when using timed sends...
    if ((typeof value !== 'string') ||
        (value.match(/^([!~%\x03\x04]|\{.*\})+/))) {
      // if (typeof value === "string" && value.match(/^%$/)) {
      //   if (!this.inHold) {
      //     // If we get a % by itthis, and we're NOT in hold, it's a comment,
      //     // toss it.
      //     return;
      //   }
      // }
      // We don't get a response for single-character codes,
      // so don't ignore them...
      if (typeof value !== 'string' || !value.match(/^[!~%\x03\x04]+$/)) {
        this.ignoredResponses++;
      }
      this._write(value);
      return;
    }

    if (value.match(/[\n\r]$/) === null) {
      value = value + '\n';
    }

    this.lineBuffer.push(value);
    this._sendLines();
  }; // write


  /**
   * _write - internal function to write unbuffered data to the g2core device
   *
   * @param  {string} value  value must be a serialized string
   * @param  {type} callback (Optional) Callback provided to the serialport
   *                         write function, which is only called for errors.
   */
  _write(value, callback) {
    if (callback === undefined) {
      callback = (err) => {
        if (err) {
          this.emit('error',
            new G2Error('Write', util.format('WRITE ERROR: ', err), err));
        }
      };
    }

    if (this.serialPortControl === null) {
      return;
    }

    if (typeof value !== 'string') {
      value = JSON.stringify(value) + '\n';
    }

    if (value.match(/[\n\r]$/) === null) {
      value = value + '\n';
    }

    let isControl = (value.match(/^(N[0-9]+\s*)?[{}!~\x01-\x19]/) &&
              !value.match(/^(N[0-9]+\s*)?{\s*(clr|clear)\s*:\s*n(ull)?\s*}/));

     if (this.useChecksums && !isControl) {
       let c = 0;
       let newValue = '';
       for (let x in value) {
         if (value[x] == '\r' || value[x] == '\n' || value[x] == ';') {
           break;
         }
         c ^= value.charCodeAt(x);
         newValue += value[x];
       }
       c ^= ';'.charCodeAt(0);
       value = `${newValue};*${c}\n`;
     }


    if (this.serialPortData === null || isControl) {
      // BTW: The optional close bracket ^^ is to appease the editor.
      this.serialPortControl.write(value, callback);
      this.emit('sentRaw', value, 'C');
    } else {
      this.serialPortData.write(value, callback);
      this.emit('sentRaw', value, 'D');
    }
  }; // _write

  /**
   * writeWithPromise - Queue data for writing and return a promise to be
   *                    fulfilled when the fulfilledFunction (or the default)
   *                    determine that the g2core has accepted the data.
   * @param  {object|string|array} data to be written. Arrays will have each
   *                                    element written individually.
   * @param {function} fulfilledFunction function that returns true OR, if
   *                                     fulfilledFunction is null, when the
   *                                     "stat" in a status report comes back
   *                                     as 3 "STOP".
   *                                     fulfilledFunction has two arguments,
   *                                     "r" which is the response or SR object,
   *                                     and "f" which is the footer for the
   *                                     response. Every sr or response will be
   *                                     passed to fulfilledFunction, and it
   *                                     should return true once it determines
   *                                     the request is fulfilled.
   * @return {promise} The promise to be fulfilled when the
   */
  writeWithPromise(data, fulfilledFunction) {
    return new Promise((resolve, reject)=>{
      if (fulfilledFunction === undefined || fulfilledFunction === null) {
        fulfilledFunction = (r)=>{
          if (r && r.sr && r.sr.stat && r.sr.stat === 3) {
            return true;
          }
          return false;
        };
      }

      let _onResponse = (r, f)=>{
        // deferred.notify(r, f);
        if (fulfilledFunction(r, f)) {
          resolve(r, f);
        }
      };

      let _onError = (e)=>{
        reject(e);
      };

      let _doStatusChanged = (sr)=>{
        // deferred.notify({sr: sr});
        if (fulfilledFunction({sr: sr})) {
          this.removeListener('statusChanged', _doStatusChanged);
          this.removeListener('response', _onResponse);
          this.removeListener('error', _onError);
          resolve(sr);
        }
      };

      this.on('response', _onResponse);
      this.on('error', _onError);
      this.on('statusChanged', _doStatusChanged);

      if (Array.isArray(data)) {
        data.forEach((v)=>{
          this.write(v);
        });
      } else {
        this.write(data);
      }
    })
    ;
  }; // writeWithPromise

  /**
   * setDoneReading - utility function to note when the last line of a file has
   *                  been *read*. Once the file is done reading, then it can be
   *                  done sending.
   * @param {bool} v is the file done reading
   */
  setDoneReading(v) {
    this.doneReading = v;
  };  // setDoneReading

  /**
   * sendFile - utility function to read a file (or STDIN) and send the contents
   *            to the g2core.
   * @param {string} filenameOrStdin filename or a readStream (presumably stdin)
   * @param {function}  callback will be called when the file is done being sent
   *                             AND the g2core machine has stopped or alarmed
   */
  sendFile(filenameOrStdin, callback) {
    // We're going to pretend that we're a "client" in this function,
    // so we're going to make an alias for this called 'g' that we'll
    // use just like any external object would.
    let g = this;

    let readStream;
    if (typeof filenameOrStdin == 'string') {
      // console.warn("Opening file '%s' for streaming.", filenameOrStdin)
      readStream = fs.createReadStream(filenameOrStdin);
    } else {
      readStream = filenameOrStdin;
      readStream.resume();
    }

    readStream.setEncoding('utf8');

    readStream.on('error', (err)=>{
      // console.log(err);
      this.emit('error',
        new G2Error('ReadStream', util.format('FILE READING ERROR: ', err), err)
      );
    });

    let needLines = 1; // We initially need lines
    let readBuffer = '';
    let nextlineNumber = 1;
    if (g.useChecksums) {
      g.write({nxln: nextlineNumber});
    }
    let lastlineNumberSeen = 0; // eslint-disable-line no-unused-vars

    // keep track of "doneness"
    let fileEnded = false;
    let doneSending = false;
    let stopOrEndStat = false;

    let _doNeedLines = (n)=>{
      needLines = n;
      readLines();
    };

    let inReadLines = false;
    let readLines = ()=>{
      if (inReadLines || !needLines) return;

      inReadLines = true;

      let data;
      data = readStream.read(4 * 1024); // read in 4K chunks
      if (data && data.length > 0) {
        readBuffer += data.toString();

        // Split collected data by line endings
        let lines = readBuffer.split(/(?:\r\n|\r|\n)+/);

        // If there is leftover data,
        readBuffer = lines.pop();

        lines = lines.filter(function(line) {
          return !line.match(/^\s*$/);
        });

        if (!this.timedSendsOnly) {
          lines = lines.map((line)=>{
            let lineMatch = line.match(/^(?:[nN][0-9]+\s*)?(.*)$/);
            if (lineMatch) {
              line = `N${nextlineNumber} ${lineMatch[1]}`;
              nextlineNumber++;
            }
            return line;
          });
        }

        g.write(lines);

        needLines -= lines.length;

        if (needLines < 0) {
          needLines = 0;
        }
      }

      if (fileEnded) {
        g.setDoneReading(true);
      }

      inReadLines = false;
    }; // readLines

    readStream.on('readable', ()=>{
      readLines();
    }); // readStream.on('readable', ... )

    readStream.on('end', ()=>{
      readStream.close();
      fileEnded = true;
      g.write(`N${nextlineNumber}M30`);
    });


    // Finishing routines
    // We make these variables so we can removeListener on them later.

    // We also look for two seperate events that have to both happen, but might
    // be in any order: 'doneSending' from the sender, and the machine going
    // into a status of 'stop' or 'end'.

    // 'doneSending' will only be sent after we call g.setDoneReading(true);


    let _doDoneSending = (forcedStop)=>{
      if (forcedStop || (fileEnded && stopOrEndStat)) {
        _finish();
      } else {
        doneSending = true;
      }
    };

    let _doStatusChanged = (sr)=>{
      if (sr.line) {
        this.lineInLastSR = sr.line;
      }

      // See https://github.com/synthetos/TinyG/wiki/TinyG-Status-Codes#status-report-enumerations
      //   for more into about stat codes.

      if (sr.stat) {
        // console.log("sr.stat: " + this.lineCountToSend)

        // 3	program stop or no more blocks (M0, M1, M60)
        // 4	program end via M2, M30
        if (sr.stat == 3 || sr.stat == 4) {
          if (sr.stat == 4) {
            if (fileEnded && doneSending) {
              _finish();
            }
            stopOrEndStat = true;
          }

        // 2	machine is in alarm state (shut down)
        } else if (sr.stat == 2) {
          // If the machine is in error, we're done no matter what
          if (!this.timedSendsOnly) {
            _finish(sr);
          }

        // 6 is holding
        } else if (sr.stat === 6) {
          stopOrEndStat = false;

        // 5 is running -- check to make sure we weren't in hold
        } else if (sr.stat === 5 && this.inHold === true) {
          stopOrEndStat = false;
        }
      } // if (sr.stat)
    }; // _doStatusChanged


    let _onResponse = (r)=>{
      lastlineNumberSeen = r.n;
    }; // _onResponse

    let _finish = (err)=>{
      if (!fileEnded) {
        // We never ended, but got here somehow
        readStream.close();
      }
      g.removeListener('needLines', _doNeedLines);
      g.removeListener('doneSending', _doDoneSending);
      g.removeListener('statusChanged', _doStatusChanged);
      g.removeListener('response', _onResponse);

      // reset "doneReading" so we can send more ...
      g.setDoneReading(false);

      if (callback) {
        callback(err);
      } else {
        this.close();
      }
    };

    // Setup the listeners..
    g.on('needLines', _doNeedLines);
    g.on('doneSending', _doDoneSending);
    g.on('statusChanged', _doStatusChanged);
    g.on('response', _onResponse);
  }; // sendFile

  /**
   * get - lookup a paramter on othe machine (via JSON)
   * @param {string} key the name of the parameter to lookup
   *   (example: `g2->get('posx')` to get the x position of the machine.)
   *   Calls `g2->set({key, null})` internally.
   * @return {promise} the promise wil be fulfilled with the returned value,
   *                    or an error.
   */
  get(key) {
    let o = {};
    o[key] = null;
    return this.set(o);
  }; // get

  /**
   * set - set the value of a parameter onthe machine (via JSON)
   * @param {string|object|value} key the name of the parameter to set (string)
   *                               OR the object to send key-by-key
   *                               OR the array of object to be sent in order
   * @param {any} value the value will be JSON tokenized and sent, ignored if
   *                    key is an object or array.
   *   (example: `g2->set('jv', 5)` to set the `jv` value to 5')
   *   (example: `g2->set({'jv': 5})` to set the `jv` value to 5')
   *   (example: `g2->set([{'jv': 5}])` to set the `jv` value to 5')
   * @return {promise} the promise wil be fulfilled with the returned value,
   *                    or an error. Note that the returned value might not be
   *                    what was passed, if g2core changed it.
   */
  set(key, value) {
    // Ok, we handle this differently.
    // If we are passed an object, such as {jv:1, ee:1} we will loop throught
    // the top-level keys and "set" each in turn, making a longer and longer
    // promise chain.

    // However, objects are unordered. So, if you pass it an array of objects,
    // we will loop through the array in order. So, you can pass this:
    // [{jv:1}, {qv:1}]

    let promiseChain;
    if (Array.isArray(key)) {
      // Create a dummy promise to start the cahin.
      promiseChain = Promise.resolve();

      let closure1 = (v)=>{
        promiseChain = promiseChain.then(()=>{
          return this.set(v);
        }).catch((e)=>{
          // console.log("Caught error setting ", v, ": ", e);
          this.emit('error', e);
          return Promise.reject(e);
        });
      };

      for (let subkey in key) {
        // We have to artificially create a function context to hold the values
        // so we make a closure function, assign the variables, and immediately
        // call it.
        if (key.hasOwnProperty.call(key, subkey)) {
          let v = key[subkey];
          closure1(v);
        }
      }

      return promiseChain;
    } else if (typeof key === 'object') {
      // Create a dummy promise to start the cahin.
      promiseChain = Promise.resolve();
      let closure2 = (k, v)=>{
        promiseChain = promiseChain.then(()=>{
          return this.set(k, v);
        }).catch((e)=>{
          // console.log("Caught error setting {", k, ":", v, "}: ", e);
          this.emit('error', e);
          return Promise.reject(e);
        });
      };

      for (let subkey in key) {
        // We have to artificially create a function context to hold the values
        // so we make a closure function, assign the variables, and immediately
        // call it.
        if ({}.hasOwnProperty.call(key, subkey)) {
          let v = key[subkey];
          closure2(subkey, v);
        }
      }

      return promiseChain;
    }

    return new Promise((resolve, reject)=>{
      let _respHandler = (r)=>{
        // deferred.notify(r);
        if (key in r) {
          this.removeListener('response', _respHandler);
          this.removeListener('error', _errHandler);

          try {
            resolve(r[key]);
          } catch(e) {
            reject(e);
          }
        }
      };

      let _errHandler = (e)=>{
        reject(e);
      };

      this.on('response', _respHandler);
      this.on('error', _errHandler);

      let toSend = {};
      toSend[key] = value;

      // console.log(">>>", toSend); // uncommment to debug writes
      this.write(toSend);
    }); // new Promise
  }; // set


  /**
   * parseGcode - parse the provided gcode (why?)
   * @param {string} line - the gcode line
   * @param {object} readFileState - a object to store the results in
   * @return {string} returns the line number, either from readFileState.line,
   *                  or parsed out fo the line
   */
  parseGcode(line, readFileState) {
    let _valueFromString = (str)=>{
      return str.substring(1)
        .replace(/^\s+|\s+$/g, '')
        .replace(/^0+?(?=[0-9]|-)/, '');
    };

    let rawLine = line;
    line = line.replace(/^\s+|\s+$/g, '')
      .replace(/(;.*)|(\(.*?\))| /g, '')
      .toLowerCase();

    let attributes = {};

    let attributesArray = line.split(/(?=[a-z])/);
    if (attributesArray.length != 0) {
      if (attributesArray[0][0] == 'n') {
        readFileState.line = _valueFromString(attributesArray[0]);
        attributesArray.shift();
      }
    }

    if (attributesArray.length != 0) {
      for (let i = 0; i < VALID_CMD_LETTERS.length; i++) {
        if (attributesArray[0][0] == VALID_CMD_LETTERS[i]) {
          readFileState.command = {};
          readFileState.command[attributesArray[0][0]] =
              _valueFromString(attributesArray[0]);

          attributesArray.shift();
          break;
        }
      };

      for (let i = 0; i < attributesArray.length; i++) {
        let attr = attributesArray[i];
        attributes[attr[0]] = _valueFromString(attr);
      };

      this.emit('sentGcode', {
        cmd: readFileState.command,
        values: attributes,
        line: readFileState.line,
        gcode: rawLine,
      });
    }

    return readFileState.line;
  }; // parseGcode

  /**
   * openFirst - open the first g2core machine found on USB
   * @param {bool} failIfMore (optional, default false) if true, returns an
   *                          error if there are multiple g2core machines found.
   * @param {object} options  (optiona) options objct to pass to open()
   *
   * @return {promise} will yield either this g2core object, or emit an 'error'
   *                   and return null. The promise can be ignored if listening
   *                   to the 'open' and 'error' events.
   */
  openFirst(failIfMore = false, options = {}) {
    let _options = options;

    let promise = this.list().then((results)=>{
      if (results.length == 1 || (failIfMore == false && results.length > 0)) {
        if (results[0].dataPortPath) {
          _options.dataPortPath = results[0].dataPortPath;
          return this.open(results[0].path, _options);
        } else {
          return this.open(results[0].path, _options);
        }
      } else if (results.length > 1) {
        let errText = 'Autodetect found multiple g2s.\n';

        for (let i = 0; i < results.length; i++) {
          let item = results[i];
          if (item.dataPortPath) {
            errText += `\tFound command port: '${item.path}' with data` +
                        ` port '${item.dataPortPath}'\n`;
          } else {
            errText += `\tFound port: '${item.path}'\n`;
          }
        }
        this.emit('error', new G2Error('OpenFirst', errText, results));
        return null;
      } else {
        this.emit('error', new G2Error('OpenFirst',
                                       'Autodetect found no connected g2s.',
                                       {}));
        return null;
      }
    }).catch((err)=>{
      this.emit('error', new G2Error('OpenFirstList', 'listing error', err));
      return null;
    });

    return promise;
  }; // openFirst

  /**
   * list - list the available possibly-g2core devices (on USB, not raw serial)
   * @return {promise} to be fulfilled with an array of objects describing
   *                   possible g2core machines attached over USB.
   */
  list() {
    return new Promise((resolve, reject)=>{
      SerialPort.list((err, results)=>{
        if (err) {
          reject(err);
          return;
        }

        let g2s = [];

        for (let i = 0; i < results.length; i++) {
          let item = results[i];

          if (process.platform === 'win32') {
            // Windows:
            // pnpId: USB\VID_1D50&PID_606D&MI_00\6&3B3CEA53&0&0000
            // pnpId: USB\VID_1D50&PID_606D&MI_02\6&3B3CEA53&0&0002

            // WARNING -- explicit test against VIP/PID combo.
            if ((x = item.pnpId.match(/^USB\\VID_([0-9A-Fa-f]+)&PID_([0-9A-Fa-f]+)&MI_([0-9]+)\\(.*)$/)) &&  // eslint-disable-line
              (x[1] == '1D50') && (x[2] == '606D')
            ) {
              // let vendor = x[1]; // never used
              // let pid = x[2];    // never used
              let theRest = x[4].split('&');
              let serialNumber = theRest[1];

              if (
                (g2s.length > 0) &&
                (g2s[g2s.length-1].serialNumber == serialNumber)
              ) {
                g2s[g2s.length-1].dataPortPath = item.comName;
                continue;
              }

              g2s.push({
                path: item.comName,
                pnpId: item.pnpId,
                serialNumber: serialNumber,
              });
            }
          } else if (process.platform === 'darwin') {
            // MacOS X:
            //  Command:
            //   {
            //     comName: '/dev/cu.usbmodem142433',
            //     manufacturer: 'Synthetos',
            //     serialNumber: '0084-d639-29c6-08c6',
            //     pnpId: '',
            //     locationId: '0x14243000',
            //     vendorId: '0x1d50',
            //     productId: '0x606d'
            //   }
            //  Data:
            //   {
            //     comName: '/dev/cu.usbmodem142431',
            //     manufacturer: 'Synthetos',
            //     serialNumber: '0084-d639-29c6-08c6',
            //     pnpId: '',
            //     locationId: '0x14243000',
            //     vendorId: '0x1d50',
            //     productId: '0x606d'
            //   }

            // console.log(util.inspect(item) + "\n\n--\n\n");

            if (item.manufacturer == 'FTDI') {
              g2s.push({path: item.comName});
            } else if (item.manufacturer == 'Synthetos') {
              if (g2s.length > 0 &&
                 (g2s[g2s.length-1].serialNumber = item.serialNumber)
                 ) {
                g2s[g2s.length-1].dataPortPath = item.comName;
              } else {
                g2s.push({path: item.comName, serialNumber: item.serialNumber});
              }
              // console.log(util.inspect(g2s) + " **");
            }
          } else {
            /* eslint-disable */
            // Linux:
            //  Command: { comName: '/dev/ttyACM0', manufacturer: undefined, pnpId: 'usb-Synthetos_TinyG_v2_002-if00' }
            //     Data: { comName: '/dev/ttyACM1', manufacturer: undefined, pnpId: 'usb-Synthetos_TinyG_v2_002-if02' }
            /* eslint-enable */
            // eslint-disable-next-line max-len
            if ((x = item.pnpId.match(/^usb-Synthetos_TinyG_v2_([0-9A-Fa-f]+)-if([0-9]+)/))) {
              if (g2s.length > 0 &&
                 // eslint-disable-next-line max-len
                 (y = g2s[g2s.length-1].pnpId.match(/^usb-Synthetos_TinyG_v2_([0-9A-Fa-f]+)-if([0-9]+)/)) &&
                 x[1] == y[1]
               ) {
                g2s[g2s.length-1].dataPortPath = item.comName;
                continue;
              }

              g2s.push({path: item.comName, pnpId: item.pnpId});
            }
          }
        } // for i in results

        resolve(g2s);
      }); // serialport.list callback.
    }); // new Promise
  }; // list
}; // class G2CoreAPI
module.exports = G2coreAPI;
