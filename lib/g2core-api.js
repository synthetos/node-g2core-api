var EventEmitter = require('events').EventEmitter;
var util = require('util');
var fs = require('fs');
var Q = require('q');
var SerialPort = require('serialport');

/**** Create the G2Error object ****/

function G2Error(subname, message, data) {
  Error.call(this);
  this.name = "G2"+subname+"Error";
  this.message = message || "Raw Data: " + util.inspect(data, {depth: null});

  this.data = data;
};
util.inherits(G2Error, Error);

/****************************/

/**** Create the G2coreAPI object ****/

function G2coreAPI() {
  // Squirrel away a ref to 'this' for use in callbacks.
  var self = this;

  //predefine
  this.serialPortControl = null;
  this.serialPortData = null;
  self.inHold = false;
  self.linesInBuffer = 0;
  self.timedSendsOnly = false;
  self.doneReading = false;
  self.lineBuffer = []; // start it out ensuring that the machine is reset;
  self.linesRequested = 0; // total number of lines to send, including self.linesSent
  self.linesSent = 0;      // number of lines that have been sent
  self.lineInLastSR = 0;
  self.ignoredResponses = 0; // Keep track of out-of-band commands to ignore responses to
  self.setupDone = false;

  var readBuffer = "";
  var _g2parser = function (emitter, buffer) {
    // Collect data
    readBuffer += buffer.toString();

    // Split collected data by line endings
    var parts = readBuffer.split(/(\r\n|\r|\n)+/);

    // If there is leftover data,
    readBuffer = parts.pop();

    parts.forEach(function (part) {
      // Cleanup and remove blank or all-whitespace lines.
      if (part.match(/^\s*$/))
        return;

      // Remove stray XON/XOFF charaters that make it through the stream.
      part = part.replace(/([\x13\x11])/, "");

      // Mark everything else with a bullet
      // console.log('part: ' + part.replace(/([\x00-\x20])/, "•"));

      self.emit('data', part);

      if (part[0] == "{" /* make the IDE happy: } */) {
        try {
          jsObject = JSON.parse(part);
        } catch(err) {
          self.emit('error', new G2Error("Parser", util.format('Unable to parse "%s": %s', part, err), {err: err, part: part}));
          return;
        }

        // We have to look in r/f for the footer due to a bug in TinyG...
        if (jsObject.hasOwnProperty('r')) {
          var footer = jsObject.f || (jsObject.r && jsObject.r.f);
          if (footer !== undefined) {
            if (footer[1] == 108) {
              self.emit('error', new G2Error(
                "Response",
                util.format("G2coreAPI reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                jsObject
              ));
            }

            else if (footer[1] == 20) {
              self.emit('error', new G2Error(
                "Response",
                util.format("G2coreAPI reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                jsObject
              ));
            }

            else if (footer[1] == 202) {
              self.emit('error', new G2Error(
                "Response",
                util.format("G2coreAPI reported an TOO SHORT MOVE on line %d", jsObject.r.n),
                jsObject
              ));
            }

            else if (footer[1] == 204) {
              self.emit('error', new G2Error(
                "InAlarm",
                util.format("G2coreAPI reported COMMAND REJECTED BY ALARM '%s'", part),
                jsObject
              ));
            }

            else if (footer[1] != 0) {
              self.emit('error', new G2Error(
                "Response",
                util.format("G2coreAPI reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                jsObject
              ));
            }

            // Remove the object so it doesn't get parsed anymore
            // delete jsObject.f;
            // if (jsObject.r) {
            //   delete jsObject.r.f;
            // }
          }

          self.emit("response", jsObject.r, footer);

          jsObject = jsObject.r;
        }

        if (jsObject.hasOwnProperty('er')) {
          self.emit("errorReport", jsObject.er);
        }
        else if (jsObject.hasOwnProperty('sr')) {
          self.emit("statusChanged", jsObject.sr);
        }
        else if (jsObject.hasOwnProperty('gc')) {
          self.emit("gcodeReceived", jsObject.gc);
        }

        if (jsObject.hasOwnProperty('rx')) {
          self.emit("rxReceived", jsObject.rx);
        }

        // if (jsObject.hasOwnProperty('qr')) {
        //   self.emit("qrReceived", jsObject, footer); // Send the whole thing -- qr is a sibling of others in the report
        // }
      }
    } // parts.forEach function
    ); // parts.forEach
  }; // _g2parser;

  this._baseOptions = {
    baudRate: 115200,
    flowcontrol: ['RTSCTS'],
    // Provide our own custom parser:
    parser: _g2parser,
    timedSendsOnly: false
  };
}

util.inherits(G2coreAPI, EventEmitter);



G2coreAPI.prototype.open = function (path, options) {
  var self = this;

  if (self.serialPortControl !== null) {
    self.emit('error', new G2Error("Open", "Unable to open g2 at path '" + path + "' -- g2 already open.", {}));
    return;
  }
  options = options || {};
  for (key in self._baseOptions) {
    options[key] = options[key] || self._baseOptions[key];
  }

  // console.log(util.inspect(options));
  self.dataPortPath = options.dataPortPath;
  self.timedSendsOnly = options.timedSendsOnly;

  self.serialPortControl = new SerialPort(path, options);

  var _onControlData = function(data) {
    self.emit('data', data);
  };
  self.serialPortControl.on('data', _onControlData);

  self.serialPortControl.once('open', function () {
    // console.error("OPENED "+path);
    process.nextTick(function() {
      self._open_second_channel(!options.dontSetup);
    });
  });

  var _onControlError = function(err) {
    self.emit('error', new G2Error("SerialPort", util.inspect(err), err));
  };

  self.serialPortControl.on('error', _onControlError);

  self.serialPortControl.once('close', function(err) {
    // console.error("CLOSED "+path);
    self.serialPortControl.removeListener('data', _onControlData);
    self.serialPortControl.removeListener('error', _onControlError);
    self.serialPortControl = null;
    self.emit('close', err);
  });
}; // open

G2coreAPI.prototype._open_second_channel = function (doSetup) {
  var self = this;

  if (self.dataPortPath) {
    self.serialPortData = new SerialPort(self.dataPortPath, self._baseOptions);

    var _dataOnData = function(data) {
      // This should NEVER happen!!
      // The data channel should never get data back.
      self.emit('data', data);
    };
    self.serialPortData.on('data', _dataOnData);

    self.serialPortData.once('open', function () {
      // console.error("OPENED2 "+self.dataPortPath);
      self._complete_open(doSetup);
    });

    var _onDataError = function(err) {
      self.emit('error', {serialPortDataError:err});
    };

    self.serialPortData.on('error', _onDataError);

    self.serialPortData.once("close", function(err) {
      // console.error("CLOSED "+self.dataPortPath);
      self.serialPortData.removeListener('data', _dataOnData);
      self.serialPortData.removeListener('error', _onDataError);
      self.serialPortData = null;
    });
  } else {
    self.serialPortData = null;
    self._complete_open(doSetup)
  }
}; // _open_second_channel

G2coreAPI.prototype._complete_open = function (doSetup) {
  var self = this;
  var seenConnectionBanner = false;

  var deferredSetup = Q.defer();
  var setupPromise = deferredSetup.promise;

  // Prepare the event listeners
  var _onResponse = function(r) {
    if (!seenConnectionBanner) {
      self.emit('connected', r);
      seenConnectionBanner = true;
      deferredSetup.resolve(r);
      return;
    }

    if (r.hasOwnProperty("rx") && self.serialPortData === null) {
      self.ignoredResponses--;
      if (!self.timedSendsOnly) {
        self.linesRequested = r.rx - 1;
      }
      // -1 is okay, that just means wait until we've sent two lines to send again
    } else if (self.ignoredResponses > 0) {
      self.ignoredResponses--;
      return;
    } else {
        if (!self.timedSendsOnly) {
          self.linesRequested++;
        }
    }

    self._sendLines();
  }; // _onResponse
  self.on('response', _onResponse);

  var _onStatusChanged = function(sr) {
    if (sr.line) {
      self.lineInLastSR = sr.line;
    }

    // See https://github.com/synthetos/TinyG/wiki/TinyG-Status-Codes#status-report-enumerations
    //   for more into about stat codes.

    // 3	program stop or no more blocks (M0, M1, M60)
    // 4	program end via M2, M30
    if (sr.stat == 3 || sr.stat == 4) {
      // if (self.doneSending) {
      //   self.emit('doneSending');
      // }

    // 2	machine is in alarm state (shut down)
    } else if (sr.stat == 2) {
      // Fatal error! Shut down!
      // self.emit('doneSending', sr);

    // 6 is holding
    } else if (sr.stat == 6) {
      // pause sending
      // self.lineCountToSend = 0;
      self.inHold = true;

    // 5 is running -- check to make sure we weren't in hold
    } else if (sr.stat == 5 && self.inHold == true) {
      self.inHold = false;

      // request a new rx object to determine how many lines to send
      // self.write({rx:null});
    }
  };  // _onStatusChanged
  self.on('statusChanged', _onStatusChanged);

  // Make sure we clean up when we close...
  self.once('close', function () {
    self.removeListener('response', _onResponse);
    self.removeListener('statusChanged', _onStatusChanged);
  });

  // Now do setup
  process.nextTick(function() {
    self.emit('open');
    if (doSetup) {
      // Poke it to get a response
      self.write({sr:null});

      setupPromise = setupPromise.delay(5).then(function() {
        self.write({clr:null});
        return self.set({jv:4}); //Set JSON verbosity to 2 (medium)
      });
      // if (self.serialPortData === null) { // we're single channel
      //   setupPromise = setupPromise.then(function () {
      //     return self.set({ex:2}); //Set flow control to 1: XON, 2: RTS/CTS
      //   });
      //   setupPromise = setupPromise.then(function () {
      //     return self.set({rxm:1}); // Set "packet mode"
      //   });
      // }
    } // if doSetup

    setupPromise = setupPromise.then(function () {
      self.setupDone = true;
      self.emit('setupDone');

      // Allow data to be sent. We'll start with 5 lines to fill the buffer.
      self.linesRequested = 5;
      self._sendLines();
    });
  }); // nextTick

}; // _complete_open

// Internal use only, but persistent

G2coreAPI.prototype._sendLines = function() {
  var self = this;

  var lastLineSent = 0;

  //console.log(util.inspect({len: self.lineBuffer.length, lineCountToSend: (self.linesRequested - self.linesSent), linesRequested: self.linesRequested, linesSent: self.linesSent}))

  while (self.lineBuffer.length > 0 && (self.linesRequested - self.linesSent) > 0) {
    var line = self.lineBuffer.shift();
    self._write(line);
    lastLineSent = self.parseGcode(line, {});
    self.linesSent++;
    // console.log("self.lineBuffer.length: " + self.lineBuffer.length)
  }

  if (self.doneReading) {
    // console.log("self.doneReading: " + self.doneReading)
    if (self.lineBuffer.length === 0) {
      self.emit('doneSending');
    }
  } else if (self.lineBuffer.length < ((self.linesRequested - self.linesSent) + 100)) {
    self.emit('needLines', (self.linesRequested - self.linesSent) - self.lineBuffer.length);
  }

  self.emit('sentLine', lastLineSent);
}

G2coreAPI.prototype.flush = function() {
  var self = this;

  // Tell everything else that we're done sending
  self.emit('doneSending', true);

  // Wipe out the line buffer
  self.lineBuffer.length = 0;

  // Reset line requested
  self.linesRequested = 5;

  // Send a queue flush followed by an alarm clear
  self._write('\x04'); // send the ^D
  self._write("{clr:n}");
};

G2coreAPI.prototype.close = function() {
  var self = this;

  // self.emit('error', util.format("tinyg.close(): ", self.serialPortControl, self.serialPortData));

  if (self.serialPortControl !== null) {
    self.serialPortControl.close();
    // if (self.serialPortData === self.serialPortControl) {
    //   self.serialPortData = null;
    // }
    // self.serialPortControl = null;
  }

  if (self.serialPortData !== null) {
    self.serialPortData.close();
    // self.serialPortData = null;
  }

  // Empty the send buffer.
  self.lineBuffer.length = 0;
  self.setupDone = false;

  // 'close' event will set self.serialPortControl = null.
};

var previous_timecode = {
  timecode: 0,
  lines: 0,
  fired: false // This is just in case a timeout fires before we've added all the lines
  // Note: that there's still a race condition, but we're mitigating it.
};

var start_timecode = 0;
var start_actual_time = 0;

G2coreAPI.prototype.write = function(value) {
  var self = this;

  if (self.timedSendsOnly && typeof value == "string") {
    if (timecodeMatch = value.match(/^(N[0-9]+\s*)?\[\[([GC])([0-9]+)\]\](.*)/)) {
      var line_num = timecodeMatch[1] || "";
      var channel = timecodeMatch[2]; // ignored
      var timecode = timecodeMatch[3];
      value = line_num + timecodeMatch[4];

      var new_timecode = {
        channel: channel,
        timecode: timecode,
        fired: false,
        lines: 1 + (previous_timecode.fired ? previous_timecode.lines : 0)
      };

      if (start_timecode == 0) {
        start_timecode = timecode;
        start_actual_time = Date.now();
      }

      var delay_time = ((new_timecode.timecode - start_timecode)-(Date.now() - start_actual_time));
      previous_timecode = new_timecode;

      setTimeout(function () {
        self.linesRequested += new_timecode.lines;
        new_timecode.lines = 0;
        new_timecode.fired = true;
        self._sendLines();
      }, delay_time);
    } else {
      previous_timecode.lines++;
    }

    // Normally, this would be a terrible idea..., but we're testing, so we do this:
    // replace all the hex-escaped string values with the actual byte value:
    value = value.replace(/\\x([0-9a-fA-F]+)/g, function(a,b) { return String.fromCharCode(parseInt(b,16)  ); })
  }

  // Handle getting passed an array
  else if (Array.isArray(value)) {
    value.forEach(function(v) {
      if (v.match(/[\n\r]$/)) {
        v = v + "\n";
      }

      self.lineBuffer.push(v);
    });
    self._sendLines();
    return;
  }

  // Specials bypass the buffer! Except when using timed sends...
  else if ((typeof value !== "string" || value.match(/^([!~%\x03\x04]|\{.*\})+/))) {
    // if (typeof value === "string" && value.match(/^%$/)) {
    //   if (!self.inHold) {
    //     // If we get a % by itself, and we're NOT in hold, it's a comment,
    //     // toss it.
    //     return;
    //   }
    // }
    // We don't get a response for single-character codes, so don't ignore them...
    if (typeof value !== "string" || !value.match(/^[!~%\x03\x04]+$/)) {
      self.ignoredResponses++;
    }
    self._write(value);
    return;
  }

  if (value.match(/[\n\r]$/) === null) {
    value = value + "\n";
  }

  self.lineBuffer.push(value);
  self._sendLines();
}


G2coreAPI.prototype._write = function(value, callback) {
  var self = this;

  if (callback === undefined) {
    callback = function(err) {
      if (err) {
        self.emit('error', new G2Error("Write", util.format("WRITE ERROR: ", err), err));
      }
    };
  }

  if (self.serialPortControl === null) {
    return;
  }

  if (typeof value !== 'string') {
    value = JSON.stringify(value) + '\n';
  }

  if (value.match(/[\n\r]$/) === null) {
    value = value + "\n";
  }

  if (self.serialPortData === null || (value.match(/^(N[0-9]+\s*)?[{}!~\x01-\x19]/) && !value.match(/^(N[0-9]+\s*)?{\s*(clr|clear)\s*:\s*n(ull)?\s*}/))) {
    // BTW: The optional close bracket ^^ is to appease the editor.
    // self.emit('error', util.format("###ctrl write: '%s'", JSON.stringify(value)))
    self.serialPortControl.write(value, callback);
    self.emit('sentRaw', value, 'C');
  } else {
    // self.emit('error', util.format("###data write: '%s'", JSON.stringify(value)))
    self.serialPortData.write(value, callback);
    self.emit('sentRaw', value, 'D');
  }
}; // _write

G2coreAPI.prototype.writeWithPromise = function(data, fulfilledFunction) {
  var self = this;

  // This will call write, but hand you back a promise that will be fulfilled
  // either once fulfilledFunction returns true OR, if fulfilledFunction is
  // null, when the "stat" in a status report comes back as 3 "STOP".

  // If data is an array, it will call write() for each element of the array.

  var deferred = Q.defer();

  if (fulfilledFunction === undefined || fulfilledFunction === null) {
    fulfilledFunction = function (r) {
      if (r && r['sr'] && r['sr']['stat'] && r['sr']['stat'] == 3) {
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


  self.on('response', _onResponse);
  self.on('error', _onError);
  self.on('statusChanged', _doStatusChanged);
  // Uncomment to debug event handler removal
  // console.log("response l>", util.inspect(self.listeners('response'))); // [ [Function] ]
  // console.log("error l>", util.inspect(self.listeners('error'))); // [ [Function] ]


  if (Array.isArray(data)) {
    data.forEach(function(v) {
      self.write(v);
    });
  } else {
    // console.log(">>>", toSend); // uncommment to debug writes
    self.write(data);
  }

  return deferred.promise.finally(function () {
    self.removeListener('statusChanged', _doStatusChanged);
    self.removeListener('response', _onResponse);
    self.removeListener('error', _onError);
  })
  // .progress(console.log) // uncomment to debug responses
  ;
}; // writeWithPromise

// Utility functions for sendinf files
G2coreAPI.prototype.setDoneReading = function(v) { this.doneReading = v; }

G2coreAPI.prototype.sendFile = function(filename_or_stdin, callback) {
  var self = this;

  // We're going to pretend that we're a "client" in this function,
  // so we're going to make an alias for self called 'g' that we'll
  // use just like any external object would.
  var g = self;

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
    self.emit('error', new G2Error("ReadStream", util.format("FILE READING ERROR: ", err), err));
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

      if (!self.timedSendsOnly) {
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
      self.lineInLastSR = sr.line;
    }

    // See https://github.com/synthetos/TinyG/wiki/TinyG-Status-Codes#status-report-enumerations
    //   for more into about stat codes.

    if (sr.stat) {
      // console.log("sr.stat: " + self.lineCountToSend)

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
        if (!self.timedSendsOnly) {
          _finish(sr);
        }

      // 6 is holding
      } else if (sr.stat == 6) {
        stopOrEndStat = false;

      // 5 is running -- check to make sure we weren't in hold
      } else if (sr.stat == 5 && self.inHold == true) {
        stopOrEndStat = false;
      }
    } // if (sr.stat)
  }; // _doStatusChanged


  var _onResponse = function (r, f) {
    // Debugging code
    // if (!r.n) {
    //   console.log("MISSING LINE NUMBER!! Should be:" + (lastlineNumberSeen+1).toString());
    //   return;
    // }
    // if (r.n != lastlineNumberSeen+1) {
    //   console.log("LINE NUMBER OUT OF SEQUENCE!! Should be:" + (lastlineNumberSeen+1).toString() + " got:" + r.n.toString());
    // }
    lastlineNumberSeen = r.n;
  } // _onResponse

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
      self.close();
    }
  };

  // Setup the listeners..
  g.on('needLines', _doNeedLines);
  g.on('doneSending', _doDoneSending);
  g.on('statusChanged', _doStatusChanged);
  g.on('response', _onResponse);
};

G2coreAPI.prototype.get = function(key) {
  var self = this;
  var o = {};
  o[key] = null;
  return self.set(o);
};


G2coreAPI.prototype.set = function(key, value) {
  var self = this;

  // Ok, we handle this differently.
  // If we are passed an object, such as {jv:1, ee:1} we will loop throught the
  // top-level keys and "set" each in turn, making a longer and longer promise
  // chain.

  // However, objects are unordered. So, if you pass it an array of objects,
  // we will loop through the array in order. So, you can pass this:
  // [{jv:1}, {qv:1}]


  if (Array.isArray(key)) {
    var promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.
    for (var k in key) {
      // We have to artificially create a function context to hold the values
      // so we make a closure function, assign the variables, and immediately call it.
      var closure = function (v) {
        promiseChain = promiseChain.then(function() {
          return self.set(v);
        }).catch(function (e) {
          //console.log("Caught error setting ", v, ": ", e);
          self.emit('error', e);
          return Q.fcall(function () {});
        });
      };
      closure(key[k]);
    };
    return promiseChain;

  } else if (typeof key === 'object') {
    var promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.
    for (var k in key) {
      // We have to artificially create a function context to hold the values
      // so we make a closure function, assign the variables, and immediately call it.
      var closure = function (k, v) {
        promiseChain = promiseChain.then(function() {
          return self.set(k, v);
        }).catch(function (e) {
          // console.log("Caught error setting {", k, ":", v, "}: ", e);
          self.emit('error', e);
          return Q.fcall(function () {});
        });
      };
      closure(k, key[k]);
    };
    return promiseChain;
  // } else if (typeof value === 'object') {
  //   var promiseChain = Q.fcall(function () {}); // Create a dummy promise to start the cahin.
  //   for (var k in value) {
  //     // We have to artificially create a function context to hold the values
  //     // so we make a closure function, assign the variables, and immediately call it.
  //     var closure = function (k, v) {
  //       promiseChain = promiseChain.then(function() {
  //         return self.set(k, v);
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

  self.on('response', _respHandler);
  self.on('error', _errHandler);
  // Uncomment to debug event handler removal
  // console.log("response l>", util.inspect(self.listeners('response'))); // [ [Function] ]
  // console.log("error l>", util.inspect(self.listeners('error'))); // [ [Function] ]

  var toSend = {};
  toSend[key] = value;

  // console.log(">>>", toSend); // uncommment to debug writes
  self.write(toSend);

  return deferred.promise.finally(function () {
    self.removeListener('response', _respHandler);
    self.removeListener('error', _errHandler);
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
  var self = this;
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

    self.emit("sentGcode", {cmd: readFileState.command, values: attributes, line:readFileState.line, gcode: rawLine});
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
  var self = this;
  var _options = options || {};

  if (fail_if_more === undefined || fail_if_more === null) {
    fail_if_more = false;
  }

  self.list().then(function (results) {
    if (results.length == 1 || (fail_if_more == false && results.length > 0)) {
      if (results[0].dataPortPath) {
        _options.dataPortPath = results[0].dataPortPath;
        return self.open(results[0].path, _options);
      } else {
        return self.open(results[0].path, _options);
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
      self.emit('error', new G2Error("OpenFirst", errText, results));
    } else {
      self.emit('error', new G2Error("OpenFirst", "Autodetect found no connected g2s.", {}));
    }

  }).catch(function(err) {
    self.emit('error', new G2Error("OpenFirstList", "listing error", err));
  });
}

G2coreAPI.prototype.stripGcode = function (gcode) {
  gcode = gcode.replace(/^(.*?);\(.*$/gm, "$1");
  gcode = gcode.replace(/[ \t]/gm, "");
  gcode = gcode.toUpperCase();
  return gcode;
}

// G2coreAPI.prototype.useSocket = function(socket) {
//   var self = this;
//
//   self.on('open', function() { socket.emit('open'); });
//   self.on('error', function(err) { socket.emit('error', err); });
//   self.on('close', function(err) { socket.emit('close', err); });
//   self.on('data', function(data) { socket.emit('data', data); });
//
//   self.on('configChanged', function(changed) { socket.emit('configChanged', changed); });
//   self.on('statusChanged', function(changed) { socket.emit('statusChanged', changed); });
//   self.on('gcodeReceived', function(gc) { socket.emit('gcodeReceived', gc); });
//   self.on('unitChanged', function(unitMultiplier) { socket.emit('unitChanged', unitMultiplier); });
//
//   // Function proxies:
//   socket.on('open', function() { self.open.apply(self, arguments); });
//   socket.on('close', function() { self.close(); });
//   socket.on('write', function(data) { self.write(data); });
//   socket.on('sendFile', function(path) { self.sendFile(path); });
//   socket.on('readFile', function(path) { self.readFile(path); });
//   socket.on('list', function() {
//     self.list(function(err, results) {
//       if (err) {
//         socket.emit('error', err);
//         return;
//       }
//       // console.log("listing:" + results);
//       socket.emit('list', results);
//     });
//   });
//   socket.on('getStatus', function(callback) { callback(self._status); });
//   socket.on('getConfiguration', function(callback) { callback(self._configuration); });
//
// };

module.exports = G2coreAPI;
