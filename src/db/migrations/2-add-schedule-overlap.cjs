'use strict';

var info = {
    "revision": 2,
    "name": "add-schedule-overlap",
    "created": "2026-03-08T20:00:00.000Z",
    "comment": "Add schedule_overlap column to Agents table"
};

var migrationCommands = function(transaction) {
    return [{
        fn: "addColumn",
        params: [
            "Agents",
            "schedule_overlap",
            {
                "type": Sequelize.STRING,
                "field": "schedule_overlap",
                "defaultValue": "skip",
                "allowNull": false
            },
            { transaction }
        ]
    }];
};

var rollbackCommands = function(transaction) {
    return [{
        fn: "removeColumn",
        params: ["Agents", "schedule_overlap", { transaction }]
    }];
};

var Sequelize = require('sequelize');

module.exports = {
    pos: 0,
    useTransaction: true,
    execute: function(queryInterface, Sequelize, _commands) {
        var index = this.pos;
        function run(transaction) {
            const commands = _commands(transaction);
            return new Promise(function(resolve, reject) {
                function next() {
                    if (index < commands.length) {
                        let command = commands[index];
                        console.log("[#" + index + "] execute: " + command.fn);
                        index++;
                        queryInterface[command.fn].apply(queryInterface, command.params).then(next, reject);
                    } else {
                        resolve();
                    }
                }
                next();
            });
        }
        if (this.useTransaction) {
            return queryInterface.sequelize.transaction(run);
        } else {
            return run(null);
        }
    },
    up: function(queryInterface, Sequelize) {
        return this.execute(queryInterface, Sequelize, migrationCommands);
    },
    down: function(queryInterface, Sequelize) {
        return this.execute(queryInterface, Sequelize, rollbackCommands);
    },
    info: info
};
