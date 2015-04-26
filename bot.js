var spawn = require("child_process").spawn;
var readline = require("readline");
var util = require("util");
var log4js = require("log4js");
var RSVP = require("rsvp");
var isInteger = require("is-integer");

var MAX_BOARDSIZE = 19;

/*
 * A single instance of Bot represents a single GNUGo process. A bot must be
 * provided with the gnugo command e.g "gnugo --mode gtp --level 10". Board
 * sizes over 19 are not supported
 */
var Bot = function(cmd, args) {
    var proc = spawn(cmd, args.split(" "));
    var logger = log4js.getLogger(util.format("Bot PID:%s", proc.pid));

    // Used to read lines out of the child process' stdout
    // TODO: figure out a better way to do this, this seems a bit overkill
    var rl = readline.createInterface(proc.stdout, proc.stdin);

    // message ID that is used when sending commands to GNUGo. This gets
    // incremented whenever a command is sent over GTP
    var cmdID = 0;

    // A map of functions to call whenever a response to a command is
    // received. Command handlers are accessed using cmdID as a number.
    var commandHandlers = {};

    // Whenever a line is read, parse the response ID and and pass rest of
    // the line to an appropriate function from commandHandlers.
    rl.on("line", function(line) {
        var err = null;
        var line = line.trim();
        if (line === "") {
            // Omit empty lines
            return
        }
        logger.debug(util.format("recv GTP: %s", line));
        if (line.charAt(0) === "?") {
            err = new Error(util.format("Received an error from GNUGo: %s", line));
        }
        var id = parseInt(line.split(" ")[0].substring(1));
        var handler = commandHandlers[id];

        if (typeof handler == "function") {
            if (err !== null) {
                handler(err);
                return;
            }
            var response = line.split(" ");
            // drop the response ID and pass the actual line to the handler
            response.shift();
            handler(response.join(" "));
            delete commandHandlers[id];
        } else {
            logger.error("No command handler for ID ", id);
        }
    });

    rl.on("end", function() {
        logger.error("Unexpected EOF");
    });

    proc.on("close", function(code, signal) {
        logger.log("Process exited PID:%d code:%d signal:%s", proc.pid, code, signal);
    });

    // Send the 'boardsize' GTP command and return a promise. Fails if the
    // requested size is larger than 19.
    this.boardsize = function(size) {
        return new RSVP.Promise(function(resolve, reject) {
            if (size > MAX_BOARDSIZE) {
                return reject(new Error("Bad size " + size));
            }
            this.gtpCommand("boardsize " + size, function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                return resolve();
            });
        }.bind(this));
    }.bind(this);

    // Send the 'play' GTP command and return a promise. Promise fails if
    // the coordinates are illegal or if something goes wrong with GNUGo
    this.play = function(move) {
        return new RSVP.Promise(function(resolve, reject) {
            var gtpCoord = toGTPCoord(move);
            if (util.isError(gtpCoord)) {
                return reject(gtpCoord);
            }
            this.gtpCommand(util.format("play %s %s", move.color, gtpCoord), function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                return resolve();
            });
        }.bind(this));
    }.bind(this);

    // Send the 'play <color> PASS' GTP command and return a promise.
    // Promise fails if the color is not "black" or "white"
    this.pass = function(color) {
        return new RSVP.Promise(function(resolve, reject) {
            if (!isLegalColor(color)) {
                return reject(new Error(util.Format("Bad color %s", color)));
            }
            this.gtpCommand(util.format("play %s PASS", color), function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                return resolve();
            });
        }.bind(this));
    }.bind(this);

    // Send the 'genmove' GTP command and return a promise. Promise fails
    // if the color is other than "black" or "white"or if something goes
    // wrong with GNUGo
    this.genmove = function(color) {
        return new RSVP.Promise(function(resolve, reject) {
            if (!isLegalColor(color)) {
                return reject(new Error(util.format("Illegal color '%s'", color)));
            }
            this.gtpCommand(util.format("genmove %s", color), function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                var move = {
                    color: color
                };
                switch (resp) {
                    case "PASS":
                        move.pass = true;
                        break;
                    case "resign":
                        move.resign = true;
                        break;
                    default:
                        var coord = fromGTPCoord(resp);
                        move.x = coord.x;
                        move.y = coord.y;
                }
                return resolve(move);
            });
        }.bind(this));
    }.bind(this);

    // Send the 'komi' GTP command and return a promise. Promise fails if
    // the provided value is not a number or if something goes wrong with
    // GNUGo.
    this.setKomi = function(komi) {
        return new RSVP.Promise(function(resolve, reject) {
            if (isNaN(komi)) {
                var komif = parseFloat(komi);
                if (isNaN(komif)) {
                    return reject(new Error(util.format("Bad value for komi (%s)", komi)));
                }
            }

            this.gtpCommand(util.format("komi %s", komi), function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                return resolve();
            });
        }.bind(this));
    }.bind(this);

    // Send the 'fixed_handicap' GTP command and return a promise. The promise
    // fails if the number of handicap stones is not an integer or if something
    // goes wrong with GNUGo
    this.setHandicap = function(numstones) {
        return new RSVP.Promise(function(resolve, reject) {
            if (!isInteger(numstones)) {
                return reject(new Error(util.format("Bad value for handicap (%s)", numstones)));
            }

            this.gtpCommand(util.format("fixed_handicap %d", numstones), function(resp) {
                if (util.isError(resp)) {
                    return reject(resp);
                }
                var stones = resp.split(" ").map(fromGTPCoord);
                return resolve(stones);
            });
        }.bind(this));
    }.bind(this);

    // Sends a command string over GTP. If handler is specified sets it to
    // be called after a response is recieved over GTP. If handler is not
    // defined a no-op handler is set.
    this.gtpCommand = function(cmd, handler) {
        if (typeof handler == "function") {
            commandHandlers[cmdID] = handler;
        } else if (typeof handler == "undefined") {
            commandHandlers[cmdID] = this.noOpHandler;
        }
        var cmdstr = util.format("%d %s\n", cmdID, cmd);
        logger.debug("send GTP:", cmdstr.trim());
        proc.stdin.write(cmdstr);
        cmdID++;
    }.bind(this);

    this.noOpHandler = function(line) {
        // do nothing!
    }.bind(this);

    this.kill = function() {
        proc.kill();
    }.bind(this);

    return this
}

// NOTE: i is missing on purpose!
// See http://senseis.xmp.net/?Coordinates for more information
var COORD_LETTERS = "abcdefghjklmnopqrst";

var fromGTPCoord = function(movestr) {
    var xchar = movestr.toLowerCase().charAt(0);
    var x = COORD_LETTERS.indexOf(xchar) + 1;
    var y = parseInt(movestr.substring(1));
    return {
        x: x,
        y: y
    };
}

var toGTPCoord = function(move) {
    if (!isInteger(move.x) || !isInteger(move.y)) {
        return new Error(util.format("Illegal coordinates x:%s y:%s", move.x, move.y));
    }
    var x = COORD_LETTERS.charAt(move.x - 1);
    var y = move.y;
    if (x === "" || y > 19) {
        return new Error(util.format("Illegal coordinates x:%s y:%s", move.x, move.y));
    }
    return x + y;
}

var isLegalColor = function(color) {
    if (color !== "black" && color !== "white") {
        return false;
    }
    return true;
}

module.exports = {
    Bot: Bot
};
