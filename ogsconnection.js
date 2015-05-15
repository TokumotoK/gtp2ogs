var socketio = require("socket.io-client");
var log4js = require("log4js");
var RSVP = require("rsvp");
var util = require("util");
var request = require("request-promise");
var querystring = require("querystring");

// Only connect to the beta server for now.
var ggsHostURL = "https://ggsbeta.online-go.com:443";
var restHostURL = "https://beta.online-go.com:443";
var apiURL = "/api/v1/";

var OGSConnection = function(opts) {
    logger = log4js.getLogger("OGSConnection");
    this.authInfo = {};

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
                    url: restHostURL + "/oauth2/access_token",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                    body: querystring.stringify({
                        "client_id": this.authInfo.client_id,
                        "client_secret": this.authInfo.client_secret,
                        "grant_type": "password",
                        "username": this.authInfo.username,
                        "password": this.authInfo.oauth2_password
                    })
                }
                logger.debug(options);
                request(options)
                    .then(function(resp) {
                            console.log(resp);
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
                //this.rejectChallenge(notification).then(function() {
                //    logger.info("rejected challenge from ", notification.user.username);
                //})
                break;
            default:
                logger.info(notification);
        }
    }.bind(this);

    OGSConnection.prototype.rejectChallenge = function(notification) {
        var options = {
            uri: restHostURL + apiURL + "/me/challenges/" + notification.id,
            method: "DELETE",
            headers: {
                "Authorization": "Bearer " + this.authInfo.client_secret
            }
        };
        logger.debug(options.headers.Authorization);
        return request(options)
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

};

module.exports = {
    OGSConnection: OGSConnection
}
