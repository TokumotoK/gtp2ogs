var spawn = require("child_process").spawn;
var readline = require("readline");
var util = require("util");
var log4js = require("log4js");

/*
 * A single instance of Bot represents a single GNUGo process. A bot must be
 * provided with the gnugo command e.g "gnugo --mode gtp --level 10". Board
 * sizes over 19 are not supported
 * TODO: add GNUGo PID to all log lines
 */
var Bot = function(cmd, args) {
	var proc = spawn(cmd, args.split(" "));
	var logger = log4js.getLogger();

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
		var line = line.trim();
		if (line === "" ) {
			logger.warn("Empty line, omit");
			return
		}
		if (line.charAt(0) === "?") {
			logger.error("Received an error from GNUGo: ", line);
			return
		}
		var id = parseInt(line.split(" ")[0].substring(1));
		var handler = commandHandlers[id];

		if( typeof handler == "function" ) {
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

	this.boardsize = function(size) {
		this.command("boardsize "+size);
	}.bind(this);

	this.play = function(move) {
		var toGTPCoord = function(move) {
			// NOTE: i is missing on purpose!
			// See http://senseis.xmp.net/?Coordinates for more information
			var x = "abcdefghjklmnopqrst".charAt(move.x-1);
			var y = move.y;
			return x+y;
		}
		var gtpCoord = toGTPCoord(move);
		this.command(util.format("play %s %s", move.color, gtpCoord));
	}.bind(this);

	this.genmove = function(color) {
		var fromGTPCoord = function(movestr) {
			var xchar = movestr.toLowerCase().charAt(0);
			// TODO: make sure that OGS' coordinates start from zero
			var x = "abcdefghjklmnopqrst".indexOf(xchar)+1;
			var y = parseInt(movestr.substring(1));
			return {x:x,y:y};
		}
		var handler = function(line) {
			var coord = fromGTPCoord(line);
			logger.debug(coord);
		}
		this.command(util.format("genmove %s", color), handler);
	}.bind(this);

	// Sends a command string over GTP. If handler is specified sets it to
	// be called after a response is recieved over GTP. If handler is not
	// defined a no-op handler is set.
	this.command = function(cmd, handler) {
		if (typeof handler == "function") {
			commandHandlers[cmdID] = handler;
		} else if(typeof handler == "undefined") {
			commandHandlers[cmdID] = this.noOpHandler;
		}
		proc.stdin.write(util.format("%d %s\n", cmdID, cmd));
		cmdID++;
	}.bind(this);

	this.noOpHandler = function(line) {
		// do nothing!
	}

	this.kill = function() {
		proc.kill();
	}.bind(this);

	return this
}

module.exports =  {
	Bot: Bot
};
