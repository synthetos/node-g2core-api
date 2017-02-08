/* eslint guard-for-in: "warn" */
'use strict';

let EventEmitter = require('events').EventEmitter;
let util = require('util');
let fs = require('fs');
let Q = require('q');
let SerialPort = require('serialport');


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

    this._baseOptions = {
      baudRate: 115200,
      flowcontrol: ['RTSCTS'],
      // Provide our own custom parser:
      parser: _g2parser,
      timedSendsOnly: false,
    };

    this._readBuffer = '';

    this._previousTimecode = {
      timecode: 0,
      lines: 0,
      fired: false, // This is just in case a timeout fires before we've added
                   // all the lines
      // Note: that there's still a race condition, but we're mitigating it.
    };

    this._startTimecode = 0;
    this._startActualTime = 0;
  }

  /**
   * _g2parser - description
   *
   * @param  {type} emitter description
   * @param  {type} buffer  description
   */
  static _g2parser(emitter, buffer) {
    // Collect data
    _readBuffer += buffer.toString();

    // Split collected data by line endings
    let parts = readBuffer.split(/(\r\n|\r|\n)+/);

    // If there is leftover data,
    _readBuffer = parts.pop();

    parts.forEach(function(part) {
      // Cleanup and remove blank or all-whitespace lines.
      if (part.match(/^\s*$/))
        return;

      // Remove stray XON/XOFF charaters that make it through the stream.
      part = part.replace(/([\x13\x11])/, '');

      // Mark everything else with a bullet
      // console.log('part: ' + part.replace(/([\x00-\x20])/, "•"));

      emitter.emit('data', part);

      if (part[0] === '{' /* make the IDE happy: } */) {
        try {
          jsObject = JSON.parse(part);
        } catch(err) {
          emitter.emit('error',
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
              emitter.emit('error', new G2Error(
                'Response',
                util.format('G2coreAPI reported an syntax error reading' +
                ' \'%s\': %d (based on %d bytes read)',
                JSON.stringify(jsObject.r), footer[1], footer[2]),
                jsObject
              ));
            } else
            if (footer[1] === 20) {
              emitter.emit('error', new G2Error(
                'Response',
                util.format('G2coreAPI reported an internal error reading' +
                            ' \'%s\': %d (based on %d bytes read)',
                            JSON.stringify(jsObject.r), footer[1], footer[2]),
                jsObject
              ));
            } else
            if (footer[1] === 202) {
              emitter.emit('error', new G2Error(
                'Response',
                util.format('G2coreAPI reported an TOO SHORT MOVE on line %d',
                            jsObject.r.n),
                jsObject
              ));
            } else
            if (footer[1] === 204) {
              emitter.emit('error', new G2Error(
                'InAlarm',
                util.format('G2coreAPI reported COMMAND REJECTED BY ALARM' +
                            ' \'%s\'', part),
                jsObject
              ));
            } else
            if (footer[1] !== 0) {
              emitter.emit('error', new G2Error(
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

          emitter.emit('response', jsObject.r, footer);

          jsObject = jsObject.r;
        }

        if (jsObject.hasOwnProperty('er')) {
          emitter.emit('errorReport', jsObject.er);
        } else
        if (jsObject.hasOwnProperty('sr')) {
          emitter.emit('statusChanged', jsObject.sr);
        } else
        if (jsObject.hasOwnProperty('gc')) {
          emitter.emit('gcodeReceived', jsObject.gc);
        }

        if (jsObject.hasOwnProperty('rx')) {
          emitter.emit('rxReceived', jsObject.rx);
        }

        // if (jsObject.hasOwnProperty('qr')) {
        //   emitter.emit("qrReceived", jsObject, footer);
        //   // Send the whole thing -- qr is a sibling of others in the report
        // }
      }
    } // parts.forEach function
    ); // parts.forEach
  }; // _g2parser;


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
    options = options || {};
    for (let key in this._baseOptions) {
      options[key] = options[key] || this._baseOptions[key];
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
      // console.error("OPENED "+path);
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
      // console.error("CLOSED "+path);
      this.serialPortControl.removeListener('data', _onControlData);
      this.serialPortControl.removeListener('error', _onControlError);
      this.serialPortControl = null;
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
        // console.error("OPENED2 "+this.dataPortPath);
        this._completeOpen(doSetup);
      });

      let _onDataError = (err) => {
        this.emit('error', {serialPortDataError: err});
      };

      this.serialPortData.on('error', _onDataError);

      this.serialPortData.once('close', (/* err */) => {
        // console.error("CLOSED "+this.dataPortPath);
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

    let deferredSetup = Q.defer();
    let setupPromise = deferredSetup.promise;

    // Prepare the event listeners
    let _onResponse = (r) => {
      if (!seenConnectionBanner) {
        this.emit('connected', r);
        seenConnectionBanner = true;
        deferredSetup.resolve(r);
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

    // Now do setup
    process.nextTick(() => {
      this.emit('open');
      if (doSetup) {
        // Poke it to get a response
        this.write({sr: null});

        setupPromise = setupPromise.delay(5).then(() => {
          this.write({clr: null});
          return this.set({jv: 4}); // Set JSON verbosity to 2 (medium)
        });
        // if (this.serialPortData === null) { // we're single channel
        //   setupPromise = setupPromise.then(function () {
        //     return this.set({ex:2}); //Set flow control to 1: XON, 2: RTS/CTS
        //   });
        //   setupPromise = setupPromise.then(function () {
        //     return this.set({rxm:1}); // Set "packet mode"
        //   });
        // }
      } // if doSetup

      setupPromise = setupPromise.then(() => {
        this.setupDone = true;
        this.emit('setupDone');

        // Allow data to be sent. We'll start with 5 lines to fill the buffer.
        this.linesRequested = 5;
        this._sendLines();
      });
    }); // nextTick
  }; // _completeOpen


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
    this.emit('error',
      util.format('g2core.close(): ',
        this.serialPortControl,
        this.serialPortData
      )
    );

    if (this.serialPortControl !== null) {
      this.serialPortControl.close();
      // if (this.serialPortData === this.serialPortControl) {
      //   this.serialPortData = null;
      // }
      // this.serialPortControl = null;
    }

    if (this.serialPortData !== null) {
      this.serialPortData.close();
      // this.serialPortData = null;
    }

    // Empty the send buffer.
    this.lineBuffer.length = 0;
    this.setupDone = false;

    // 'close' event will set this.serialPortControl = null.
  }; // close


  /**
   * write - description
   *
   * @param  {type} value description
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
   * _write - description
   *
   * @param  {type} value    description
   * @param  {type} callback description
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

    if (this.serialPortData === null ||
          (value.match(/^(N[0-9]+\s*)?[{}!~\x01-\x19]/) &&
           !value.match(/^(N[0-9]+\s*)?{\s*(clr|clear)\s*:\s*n(ull)?\s*}/)
      )) {
      // BTW: The optional close bracket ^^ is to appease the editor.
      // this.emit('error', util.format("###ctrl write: '%s'",
      //  JSON.stringify(value)))
      this.serialPortControl.write(value, callback);
      this.emit('sentRaw', value, 'C');
    } else {
      // this.emit('error', util.format("###data write: '%s'",
      //  JSON.stringify(value)))
      this.serialPortData.write(value, callback);
      this.emit('sentRaw', value, 'D');
    }
  }; // _write

} // class G2CoreAPI

G2coreAPI.prototype.writeWithPromise = function(data, fulfilledFunction) {
  // This will call write, but hand you back a promise that will be fulfilled
  // either once fulfilledFunction returns true OR, if fulfilledFunction is
  // null, when the "stat" in a status report comes back as 3 "STOP".

  // If data is an array, it will call write() for each element of the array.

  var deferred = Q.defer();

  if (fulfilledFunction === undefined || fulfilledFunction === null) {
    fulfilledFunction = function (r) {
      if (r && r.sr && r.sr.stat && r.sr.stat === 3) {
        return true;
      }

      return false;
    }
  }

  var _onResponse = function (r, f) {
    deferred.notify(r, f);
    if (fulfilledFunction(r, f)) {
      try {
        deferred.resolve(r, f);
      } catch(e) {
        deferred.reject(e);
      }
    }
  }

  var _onError = function(e) {
    deferred.notify(e);
  }

  var _doStatusChanged = function(sr) {
    deferred.notify({sr:sr});

    if (fulfilledFunction({sr:sr})) {
      try {
        deferred.resolve(sr);
      } catch(e) {
        deferred.reject(e);
      }
    }
  }


  this.on('response', _onResponse);
  this.on('error', _onError);
  this.on('statusChanged', _doStatusChanged);
  // Uncomment to debug event handler removal
  // console.log("response l>", util.inspect(this.listeners('response'))); // [ [Function] ]
  // console.log("error l>", util.inspect(this.listeners('error'))); // [ [Function] ]


  if (Array.isArray(data)) {
    data.forEach(function(v) {
      this.write(v);
    });
  } else {
    // console.log(">>>", toSend); // uncommment to debug writes
    this.write(data);
  }

  return deferred.promise.finally(function () {
    this.removeListener('statusChanged', _doStatusChanged);
    this.removeListener('response', _onResponse);
    this.removeListener('error', _onError);
  })
  // .progress(console.log) // uncomment to debug responses
  ;
}; // writeWithPromise

// Utility functions for sendinf files
G2coreAPI.prototype.setDoneReading = function(v) { this.doneReading = v; }

G2coreAPI.prototype.sendFile = function(filename_or_stdin, callback) {
  // We're going to pretend that we're a "client" in this function,
  // so we're going to make an alias for this called 'g' that we'll
  // use just like any external object would.
  var g = this;

  var readStream;
  if (typeof filename_or_stdin == 'string') {
    // console.warn("Opening file '%s' for streaming.", filename_or_stdin)
    readStream = fs.createReadStream(filename_or_stdin);
  } else {
    readStream = filename_or_stdin;
    readStream.resume();
  }

  readStream.setEncoding('utf8');

  readStream.on('error', function(err) {
    // console.log(err);
    this.emit('error', new G2Error("ReadStream", util.format("FILE READING ERROR: ", err), err));
  });

  var needLines = 1; // We initially need lines
  var readBuffer = "";
  var nextlineNumber = 1;
  var lastlineNumberSeen = 0;

  // keep track of "doneness"
  var fileEnded = false;
  var doneSending = false;
  var stopOrEndStat = false;

  var _doNeedLines = function (n) {
    needLines = n;
    _readLines();
  };

  var _in_readLines = false;
  var _readLines = function () {
    if (_in_readLines || !needLines) return;

    _in_readLines = true;

    var data;
    data = readStream.read(4 * 1024); // read in 4K chunks
    if (data && data.length > 0) {
      readBuffer += data.toString();

      // Split collected data by line endings
      var lines = readBuffer.split(/(?:\r\n|\r|\n)+/);

      // If there is leftover data,
      readBuffer = lines.pop();

      lines = lines.filter(function(line) {
        return !line.match(/^\s*$/);
      });

      if (!this.timedSendsOnly) {
        lines = lines.map(function (line) {
          lineMatch = line.match(/^(?:[nN][0-9]+\s*)?(.*)$/);
          if (lineMatch) {
            line = 'N' + nextlineNumber.toString() + " " + lineMatch[1];
            nextlineNumber++;
          }
          return line;
        })
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

    _in_readLines = false;
  }; // _readLines

  readStream.on('readable', function() {
    _readLines();
  }); // readStream.on('readable', ... )

  readStream.on('end', function() {
    readStream.close();
    fileEnded = true;
  });


  // Finishing routines
  // We make these variables so we can removeListener on them later.

  // We also look for two seperate events that have to both happen, but might
  // be in any order: 'doneSending' from the sender, and the machine going
  // into a status of 'stop' or 'end'.

  // 'doneSending' will only be sent after we call g.setDoneReading(true);


  var _doDoneSending = function (forcedStop) {
    if (forcedStop || (fileEnded && stopOrEndStat)) {
      _finish();
    } else {
      doneSending = true;
    }
  };

  var _doStatusChanged = function(sr) {
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


  var _onResponse = function (r) {
    // Debugging code
    // if (!r.n) {
    //   console.log("MISSING LINE NUMBER!! Should be:" + (lastlineNumberSeen+1).toString());
    //   return;
    // }
    // if (r.n != lastlineNumberSeen+1) {
    //   console.log("LINE NUMBER OUT OF SEQUENCE!! Should be:" + (lastlineNumberSeen+1).toString() + " got:" + r.n.toString());
    // }
    lastlineNumberSeen = r.n;
  }; // _onResponse

  var _finish = function (err) {
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
    }
    else {
      this.close();
    }
  };

  // Setup the listeners..
  g.on('needLines', _doNeedLines);
  g.on('doneSending', _doDoneSending);
  g.on('statusChanged', _doStatusChanged);
  g.on('response', _onResponse);
};

G2coreAPI.prototype.get = function(key) {
  var o = {};
  o[key] = null;
  return this.set(o);
};


G2coreAPI.prototype.set = function(key, value) {
  // Ok, we handle this differently.
  // If we are passed an object, such as {jv:1, ee:1} we will loop throught the
  // top-level keys and "set" each in turn, making a longer and longer promise
  // chain.

  // However, objects are unordered. So, if you pass it an array of objects,
  // we will loop through the array in order. So, you can pass this:
  // [{jv:1}, {qv:1}]

  var promiseChain;
  var k;
  if (Array.isArray(key)) {
    promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.

    var closure1 = function (v) {
      promiseChain = promiseChain.then(function() {
        return this.set(v);
      }).catch(function (e) {
        //console.log("Caught error setting ", v, ": ", e);
        this.emit('error', e);
        return Q.fcall(function () {});
      });
    };

    for (k in key) {
      // We have to artificially create a function context to hold the values
      // so we make a closure function, assign the variables, and immediately call it.
      var v = key[k];
      closure1(v);
    }
    return promiseChain;

  } else if (typeof key === 'object') {
    promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.
    var closure2 = function (k, v) {
      promiseChain = promiseChain.then(function() {
        return this.set(k, v);
      }).catch(function (e) {
        // console.log("Caught error setting {", k, ":", v, "}: ", e);
        this.emit('error', e);
        return Q.fcall(function () {});
      });
    };

    for (k in key) {
      // We have to artificially create a function context to hold the values
      // so we make a closure function, assign the variables, and immediately call it.
      closure2(k, key[k]);
    }

    return promiseChain;
  // } else if (typeof value === 'object') {
  //   var promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.
  //   for (var k in value) {
  //     // We have to artificially create a function context to hold the values
  //     // so we make a closure function, assign the variables, and immediately call it.
  //     var closure = function (k, v) {
  //       promiseChain = promiseChain.then(function() {
  //         return this.set(k, v);
  //       }).catch(function (e) {
  //         console.log("Caught error setting {", k, ":", v, "}: ", e);
  //         return Q.fcall(function () {});
  //       });
  //     };
  //     closure(key+k, value[k]);
  //   };
  //   return promiseChain;
  }

  var deferred = Q.defer();

  var _respHandler = function (r) {
    deferred.notify(r);
    if (key in r) {
      try {
        deferred.resolve(r[key]);
      } catch(e) {
        deferred.reject(e);
      }
    }
  }

  var _errHandler = function(e) {
    deferred.reject(e);
    // deferred.resolve();
  }

  this.on('response', _respHandler);
  this.on('error', _errHandler);
  // Uncomment to debug event handler removal
  // console.log("response l>", util.inspect(this.listeners('response'))); // [ [Function] ]
  // console.log("error l>", util.inspect(this.listeners('error'))); // [ [Function] ]

  var toSend = {};
  toSend[key] = value;

  // console.log(">>>", toSend); // uncommment to debug writes
  this.write(toSend);

  return deferred.promise.finally(function () {
    this.removeListener('response', _respHandler);
    this.removeListener('error', _errHandler);
  })
  //.progress(console.log) // uncomment to debug responses
  ;
};


var VALID_CMD_LETTERS = ["m","g","t"];
var ABSOLUTE = 0;
var RELATIVE = 1;

function _valueFromString(str) {
  return str.substring(1).replace(/^\s+|\s+$/g, '').replace(/^0+?(?=[0-9]|-)/,'');
}

G2coreAPI.prototype.parseGcode = function(line, readFileState) {
  var rawLine = line;
  line = line.replace(/^\s+|\s+$/g, '').replace(/(;.*)|(\(.*?\))| /g , '').toLowerCase();

  var attributes = {};

  var attributes_array = line.split(/(?=[a-z])/);
  if (attributes_array.length != 0) {
    if (attributes_array[0][0] == 'n') {
      readFileState.line = _valueFromString(attributes_array[0]);
      attributes_array.shift();
    }
  }

  if (attributes_array.length != 0) {
    for (var i = 0; i < VALID_CMD_LETTERS.length; i++) {
      if (attributes_array[0][0] == VALID_CMD_LETTERS[i]) {
        readFileState.command = {};
        readFileState.command[attributes_array[0][0]] = _valueFromString(attributes_array[0]);

        attributes_array.shift();
        break;
      }
    };

    for (var i = 0; i < attributes_array.length; i++) {
      var attr = attributes_array[i];
      attributes[attr[0]] = _valueFromString(attr);
    };

    this.emit("sentGcode", {cmd: readFileState.command, values: attributes, line:readFileState.line, gcode: rawLine});
  }

  return readFileState.line;
};

G2coreAPI.prototype.list = function(callback) {
  var deferred = Q.defer();

  SerialPort.list(function (err, results) {
    if (err) {
      deferred.reject(err);
      return;
    }

    var g2s = [];

    for (var i = 0; i < results.length; i++) {
      var item = results[i];

      if (process.platform === 'win32') {
        // Windows:
        // pnpId: USB\VID_1D50&PID_606D&MI_00\6&3B3CEA53&0&0000
        // pnpId: USB\VID_1D50&PID_606D&MI_02\6&3B3CEA53&0&0002

        // WARNING -- explicit test against VIP/PID combo.
        if ((x = item.pnpId.match(/^USB\\VID_([0-9A-Fa-f]+)&PID_([0-9A-Fa-f]+)&MI_([0-9]+)\\(.*)$/)) && (x[1] == '1D50') && (x[2] == '606D')) {
          var vendor = x[1];
          var pid = x[2];
          var theRest = x[4].split('&');
          var serialNumber = theRest[1];

          if ((g2s.length > 0) && (g2s[g2s.length-1].serialNumber == serialNumber)) {
            g2s[g2s.length-1].dataPortPath = item.comName;
            continue;
          }

          g2s.push({path: item.comName, pnpId: item.pnpId, serialNumber: serialNumber});
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
          // if (g2s.length > 0 && (x = g2s[g2s.length-1].path.match(/^(.*?)([0-9]+)/)) && (y = item.comName.match(/^(.*?)([0-9]+)/)) && x[1] == y[1]) {
          //   x[2] = parseInt(x[2]);
          //   y[2] = parseInt(y[2]);
          //
          //   if (((x[2] == 1) && (y[2] == 3)) || (x[2]+1 == y[2]) || (x[2]+2 == y[2])) {
          //     g2s[g2s.length-1].dataPortPath = item.comName;
          //     continue;
          //   }
          if (g2s.length > 0 && (g2s[g2s.length-1].serialNumber = item.serialNumber)) {
            g2s[g2s.length-1].dataPortPath = item.comName;
          } else {
            g2s.push({path: item.comName, serialNumber: item.serialNumber});
          }
          // console.log(util.inspect(g2s) + " **");
        }
      } else {
        // Linux:
        //  Command: { comName: '/dev/ttyACM0', manufacturer: undefined, pnpId: 'usb-Synthetos_TinyG_v2_002-if00' }
        //     Data: { comName: '/dev/ttyACM1', manufacturer: undefined, pnpId: 'usb-Synthetos_TinyG_v2_002-if02' }
        if ((x = item.pnpId.match(/^usb-Synthetos_TinyG_v2_([0-9A-Fa-f]+)-if([0-9]+)/))) {
          if (g2s.length > 0 && (y = g2s[g2s.length-1].pnpId.match(/^usb-Synthetos_TinyG_v2_([0-9A-Fa-f]+)-if([0-9]+)/)) && x[1] == y[1]) {
            g2s[g2s.length-1].dataPortPath = item.comName;
            continue;
          }

          g2s.push({path: item.comName, pnpId: item.pnpId});
        }
      }

      // if (item.manufacturer == 'FTDI' || item.manufacturer == 'Synthetos') {
        // tinygOnlyResults.push(item);
      // }
    } // for i in results

    deferred.resolve(g2s);
  }); // serialport.list callback.

  return deferred.promise;
};


G2coreAPI.prototype.openFirst = function (fail_if_more, options) {
  var _options = options || {};

  if (fail_if_more === undefined || fail_if_more === null) {
    fail_if_more = false;
  }

  this.list().then(function (results) {
    if (results.length == 1 || (fail_if_more == false && results.length > 0)) {
      if (results[0].dataPortPath) {
        _options.dataPortPath = results[0].dataPortPath;
        return this.open(results[0].path, _options);
      } else {
        return this.open(results[0].path, _options);
      }
    } else if (results.length > 1) {
      var errText = "Autodetect found multiple g2s.\n";//("Error: Autodetect found multiple g2s:\n");

      for (var i = 0; i < results.length; i++) {
        var item = results[i];
        if (item.dataPortPath) {
          errText += util.format("\tFound command port: '%s' with data port '%s'\n", item.path, item.dataPortPath);
        } else {
          errText += util.format("\tFound port: '%s'\n", item.path);
        }
      }
      this.emit('error', new G2Error("OpenFirst", errText, results));
    } else {
      this.emit('error', new G2Error("OpenFirst", "Autodetect found no connected g2s.", {}));
    }

  }).catch(function(err) {
    this.emit('error', new G2Error("OpenFirstList", "listing error", err));
  });
}

G2coreAPI.prototype.stripGcode = function (gcode) {
  gcode = gcode.replace(/^(.*?);\(.*$/gm, "$1");
  gcode = gcode.replace(/[ \t]/gm, "");
  gcode = gcode.toUpperCase();
  return gcode;
}

// G2coreAPI.prototype.useSocket = function(socket) {
//   var this = this;
//
//   this.on('open', function() { socket.emit('open'); });
//   this.on('error', function(err) { socket.emit('error', err); });
//   this.on('close', function(err) { socket.emit('close', err); });
//   this.on('data', function(data) { socket.emit('data', data); });
//
//   this.on('configChanged', function(changed) { socket.emit('configChanged', changed); });
//   this.on('statusChanged', function(changed) { socket.emit('statusChanged', changed); });
//   this.on('gcodeReceived', function(gc) { socket.emit('gcodeReceived', gc); });
//   this.on('unitChanged', function(unitMultiplier) { socket.emit('unitChanged', unitMultiplier); });
//
//   // Function proxies:
//   socket.on('open', function() { this.open.apply(this, arguments); });
//   socket.on('close', function() { this.close(); });
//   socket.on('write', function(data) { this.write(data); });
//   socket.on('sendFile', function(path) { this.sendFile(path); });
//   socket.on('readFile', function(path) { this.readFile(path); });
//   socket.on('list', function() {
//     this.list(function(err, results) {
//       if (err) {
//         socket.emit('error', err);
//         return;
//       }
//       // console.log("listing:" + results);
//       socket.emit('list', results);
//     });
//   });
//   socket.on('getStatus', function(callback) { callback(this._status); });
//   socket.on('getConfiguration', function(callback) { callback(this._configuration); });
//
// };

module.exports = G2coreAPI;
