var spawn = require("child_process").spawn;
var readline = require("readline");
var util = require("util");

/*
 * A single instance of Bot represents a single GNUGo process. A bot must be
 * provided with the gnugo command e.g "gnugo --mode gtp --level 10"
 */
var Bot = function(cmd, args) {
	var proc = spawn(cmd, args.split(" "));

	// Used to read lines out of the child process' stdout
	// TODO: figure out a better way to do this, this seems a bit overkill
	var rl = readline.createInterface(proc.stdout, proc.stdin);

	// message ID that is used when sending commands to GNUGo. This gets
	// incremented whenever a command is sent over GTP
	var cmdID = 0;

	// A map of functions to call whenever a response to a command is
	// received. Command handlers are accessed using cmdID as a string to
	// save the trouble of converting the ID received from GTP to an int.
	// TODO: figure out whether or not this is a good idea
	var commandHandlers = {};

	rl.on("line", function(line) {
		console.log(line);
		if (line.charAt(0) === "?") {
			console.log("Received an error from GNUGo: ", line);
			return
		}
		var id = line.split(" ")[0].substring(1);
		var handler = commandHandlers[id];

		if( typeof handler == "function" ) {
			var response = line.split(" ");
			// drop the response ID and pass the actual line to the handler
			response.shift();
			handler(response.join(" "));
			delete commandHandlers[id];
		} else {
			console.log("No command handler for ID ", id);
		}
	});
	rl.on("end", function() {
		console.log("Unexpected EOF");
	});

	proc.on("close", function(code, signal) {
		console.log(code, signal);
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
		commandHandlers[cmdID.toString()] = function(line) {
			var coord = fromGTPCoord(line);
			console.log(coord);
		}
		this.command(util.format("genmove %s", color));
	}.bind(this);

	this.command = function(cmd) {
		proc.stdin.write(util.format("%d %s\n", cmdID, cmd));
		cmdID++;
	}.bind(this);

	this.kill = function() {
		proc.kill();
	}.bind(this);

	return this
}

module.exports =  {
	Bot: Bot
};
