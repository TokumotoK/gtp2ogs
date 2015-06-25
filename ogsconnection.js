var socketio = require("socket.io-client");

var log4js = require("log4js");
var RSVP = require("rsvp");
var util = require("util");
var request = require("request-promise");
var querystring = require("querystring");
var Bot = require("./bot.js").Bot;

// Only connect to the beta server for now.
var ggsHostURL = "https://ggsbeta.online-go.com:443";
var restHostURL = "https://beta.online-go.com:443";
var apiURL = "/api/v1/";
var accessTokenURI = "/oauth2/access_token";

// TODO Game: add proper gamestate parsing (play existing moves to GNUGo)
// TODO fromOGSCoord/toOGSCoord: fix coordinate conversion (GTP <-> OGS)
var OGSConnection = function(opts) {
    logger = log4js.getLogger("OGSConnection");
    this.authInfo = {};
    this.activeGames = {};
    this.blacklistedPlayers = [];

    OGSConnection.prototype.connect = function() {
        return new RSVP.Promise(function(resolve, reject) {
            logger.info("Connecting to:", ggsHostURL);
            this.socket = socketio(ggsHostURL, {});
            this.socket.on("connect", function() {
                logger.info("Connected to:", ggsHostURL);
                return resolve();
            }.bind(this));

            this.socket.on("connect_error", function(error) {
                logger.error(error);
                return reject(error);
            }.bind(this));
        }.bind(this));
    }.bind(this);

    OGSConnection.prototype.login = function() {
        return new RSVP.Promise(function(resolve, reject) {
            var args = {
                id: opts.botname
            };

            this.socket.emit("bot/id", args, function(id) {
                if (!id) {
                    return reject(new Error(util.format("Bot account is not known to the system:", botname)));
                }
                logger.info("Bot ID:", id);

                this.authInfo = {
                    bot_id: id,
                    username: opts.botname,
                    apikey: opts.apikey,
                    client_id: opts.client_id,
                    client_secret: opts.client_secret,
                    oauth2_password: opts.oauth2_password
                };

                var options = {
                    url: restHostURL + accessTokenURI,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Host": "beta.online-go.com",
                    },
                    body: querystring.stringify({
                        client_id: this.authInfo.client_id,
                        client_secret: this.authInfo.client_secret,
                        grant_type: "password",
                        username: this.authInfo.username,
                        password: this.authInfo.oauth2_password
                    })
                }

                request(options)
                    .then(function(resp) {
                            this.authInfo.oauth = JSON.parse(resp);
                            // Apparently this event has to emitted for the login to work
                            this.socket.emit("notification/connect", this.authInfo);

                            // TODO: figure out what event is emitted if something goes
                            // wrong so reject() can be called
                            this.socket.emit("bot/connect", this.authInfo, function() {
                                logger.info("Logged in as", opts.botname);
                                return resolve()
                            }.bind(this));
                            this.socket.on("notification", this.notificationHandler);
                        }.bind(this),
                        function(err) {
                            console.log(err.error);
                            process.exit();
                        }.bind(this))
            }.bind(this));
        }.bind(this));
    }.bind(this);

    OGSConnection.prototype.notificationHandler = function(notification) {
        switch (notification.type) {
            case "challenge":
                logger.info("Received challenge from user", notification.user.username);

                if (this.isBlacklistedPlayer(notification)) {
                    this.rejectChallenge(notification).then(function() {
                        logger.info("Player %s is blacklisted, challenge rejected", notification.user.username);
                    }, function(resp) {
                        logger.error(resp.error);
                    });
                    break;
                }

                this.acceptChallenge(notification).then(function(resp) {
                    /*
                     * After accepting a challenge, we have to add it to
                     * this.activeGames, this is a bit complicated because
                     * after a challenge is accepted 2 notifications with the
                     * following types are emitted "yourMove" and "gameStarted"
                     *
                     * It looks like the 'yourMove' notification is emitted
                     * first, but due to the asynchronous nature of socket.io,
                     * that cannot be trusted.
                     *
                     * That is why we have to handle both notifications as if
                     * they are the first and cannot make any assumptions about
                     * the data in this.activeGames for that game.
                     *
                     * Things like this can cause really hard to catch bugs...
                     */
                    this.activeGames[resp.game] = resp;
                    logger.info("New game: ", resp.games);
                }.bind(this), function(err) {
                    logger.error(err);
                }.bind(this));

                break;

            case "gameStarted":
                var botName = this.authInfo.username;
                var botColor = notification.black == botName ? "black" : "white";
                var opponent = notification.black === botName ? notification.white : notification.black;

                logger.info("Game against " + opponent + " started");
                var game_id = notification.game_id;

                this.initGame(notification);
                break;

            case "yourMove":
                //    var game_id = notification.game_id;

                //    if (this.activeGames[game_id] === undefined) {
                //        this.initGame(notification);
                //    }
                //    var game = this.activeGames[game_id];

                //    if (game.botInstance !== undefined) {
                //        game.promise = game.botInstance.genmove(game.botColor)
                //            .then(function(coord) {
                //                return this.playMove(game_id, this.toOGSCoord(coord));
                //            }.bind(this), function(err) {
                //                logger.error(err);
                //            })
                //    };
                break;

            case "gameEnded":
                var game = this.activeGames[notification.game_id];
                if (game !== undefined && game !== null) {
                    delete this.activeGames[notification.game_id];
                }
                break;

            default:
                logger.info(notification);
        }
    }.bind(this);

    OGSConnection.prototype.isBlacklistedPlayer = function(notification) {
        if (this.blacklistedPlayers.indexOf(notification.user.username) != -1) {
            return true;
        }
        return false;
    }.bind(this);

    OGSConnection.prototype.rejectChallenge = function(notification) {
        var options = {
            uri: restHostURL + apiURL + "me/challenges/" + notification.challenge_id,
            method: "DELETE",
            headers: {
                "Authorization": "Bearer " + this.authInfo.oauth.access_token,
                "Host": "beta.online-go.com"
            }
        };
        return request(options)
    }.bind(this);

    OGSConnection.prototype.acceptChallenge = function(notification) {
        logger.info("Accepting challenge from " + notification.user.username);
        var options = {
            uri: restHostURL + apiURL + "me/challenges/" + notification.challenge_id + "/accept/",
            method: "POST",
            headers: {
                "Authorization": "Bearer " + this.authInfo.oauth.access_token,
                "Host": "beta.online-go.com"
            }
        }
        return request(options);
    }.bind(this);


    OGSConnection.prototype.playMove = function(game_id, coords) {
        var options = {
            uri: restHostURL + apiURL + "games/" + game_id + "/move/",
            method: "POST",
            form: {
                move: coords
            },
            headers: {
                "Authorization": "Bearer " + this.authInfo.oauth.access_token,
                "Host": "beta.online-go.com"
            }
        }
        return request(options);

    }.bind(this);

    OGSConnection.prototype.deleteNotification = function(notification) {
        logger.info(notification.type);
        this.socket.emit("notification/delete", {
            notification_id: notification.id,
            bot_id: this.authInfo.bot_id,
            apikey: this.authInfo.apikey
        }, function() {
            logger.info("Deleted notification", notification.id);
        }.bind(this));
    }.bind(this);

    OGSConnection.prototype.initGame = function(notification) {
        var game_id = notification.game_id;
        if (this.activeGames[game_id] === undefined) {
            request({
                    uri: restHostURL + apiURL + "games/" + game_id,
                    method: "GET",
                    headers: {
                        "Authorization": "Bearer " + this.authInfo.oauth.access_token,
                        "Host": "beta.online-go.com"
                    }
                })
                .then(function(resp) {
                    var gameInfo = JSON.parse(resp);
                    this.activeGames[game_id] = new Game(this.socket, {
                        name: this.authInfo.username,
                        auth: gameInfo.auth
                    }, notification);
                }.bind(this));
        }
    }.bind(this);
};

var toOGSCoord = function(coord) {
    // NOTE: i is missing on purpose!
    var letters = "abcdefghjklmnopqrst";
    var x = letters[coord.x - 1];
    var y = letters[coord.y - 2];
    return x + y;
};

var fromOGSCoord = function(coord) {
    // NOTE: i is missing on purpose!
    var letters = "abcdefghjklmnopqrst";
    var x = letters.indexOf(coord[0]) + 1;
    var y = letters.indexOf(coord[1]) + 1;
    return {
        x: x,
        y: y
    };
};

var Game = function(socket, botInfo, opts) {
    this.socket = socket;
    this.botInfo = botInfo;
    this.game_id = opts.game_id;
    this.player_id = opts.player_id;
    this.logger = log4js.getLogger(util.format("Game ID:%s", this.game_id));
    this.gameURI = "game/" + this.game_id;
    this.botTurn = false;

    this.socket.emit("game/connect", {
        game_id: this.game_id,
        player_id: this.player_id,
        chat: true // TODO: figure out what actually happens if this is set to false 
    });

    this.socket.on(this.gameURI + "/gamedata", function(gamedata) {
        this.logger.info("gamedata received");
        this.gamedata = gamedata;
        this.bot = this.initBot();
        this.botTurn = this.gamedata.phase === "play";
        this.botColor = this.gamedata.players.black.username === this.botInfo.name ? "black" : "white";

        if (this.botTurn) {
            this.generateBotMove();
        }
    }.bind(this));

    this.socket.on(this.gameURI + "/move", function(move) {
        console.log("MOVE", this.botTurn, move);
        if (this.botTurn) {
            this.generateBotMove();
        } else {
            this.addOpponentMove(move);
        }
    }.bind(this));

    Game.prototype.initBot = function() {
        var bot = new Bot("gnugo", "--mode gtp");
        bot.boardsize(this.gamedata.height)
            .then(function() {
                return bot.setKomi(this.gamedata.komi);
            }.bind(this))
            .then(function() {
                if (this.gamedata.handicap > 0) {
                    return bot.setHandicap(this.gamedata.handicap);
                }
            }.bind(this))
        return bot
    }.bind(this);

    Game.prototype.generateBotMove = function() {
        this.bot.genmove(this.botColor)
            .then(function(move) {
                this.botTurn = false;
                this.logger.debug("GENERATED MOVE: ", move);
                this.socket.emit("game/move", {
                    auth: this.botInfo.auth,
                    game_id: this.game_id,
                    player_id: this.player_id,
                    move: toOGSCoord(move)
                });

            }.bind(this));
    }.bind(this);

    Game.prototype.addOpponentMove = function(move) {
        var coords = fromOGSCoord(move.move);
        this.bot.play({
                x: coords.x,
                y: coords.y,
                color: this.botColor === "black" ? "white" : "black"
            })
            .then(function() {
                this.botTurn = true;
                this.logger.debug("Bot's turn!");
                return this.generateBotMove();
            }.bind(this), function(err) {
                console.log(err);
            });
    }.bind(this);
}

module.exports = {
    OGSConnection: OGSConnection
}
