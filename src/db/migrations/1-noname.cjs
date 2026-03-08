'use strict';

var Sequelize = require('sequelize');

/**
 * Actions summary:
 *
 * createTable "Agents", deps: []
 * createTable "AgentLogs", deps: []
 * createTable "Runs", deps: []
 * createTable "Messages", deps: []
 * createTable "Folders", deps: []
 *
 **/

var info = {
    "revision": 1,
    "name": "noname",
    "created": "2026-03-08T08:52:49.732Z",
    "comment": ""
};

var migrationCommands = function(transaction) {
    return [{
            fn: "createTable",
            params: [
                "Agents",
                {
                    "id": {
                        "type": Sequelize.UUID,
                        "field": "id",
                        "primaryKey": true
                    },
                    "folder_id": {
                        "type": Sequelize.UUID,
                        "field": "folder_id",
                        "defaultValue": "00000000-0000-0000-0000-000000000000",
                        "allowNull": false
                    },
                    "name": {
                        "type": Sequelize.STRING,
                        "field": "name",
                        "unique": true,
                        "allowNull": false
                    },
                    "type": {
                        "type": Sequelize.STRING,
                        "field": "type",
                        "allowNull": false
                    },
                    "status": {
                        "type": Sequelize.STRING,
                        "field": "status",
                        "defaultValue": "idle",
                        "allowNull": false
                    },
                    "cwd": {
                        "type": Sequelize.STRING,
                        "field": "cwd",
                        "allowNull": false
                    },
                    "model": {
                        "type": Sequelize.STRING,
                        "field": "model",
                        "defaultValue": "claude-sonnet-4-20250514",
                        "allowNull": false
                    },
                    "system_prompt": {
                        "type": Sequelize.TEXT,
                        "field": "system_prompt",
                        "allowNull": false
                    },
                    "tools": {
                        "type": Sequelize.JSON,
                        "field": "tools",
                        "defaultValue": Sequelize.Array,
                        "allowNull": false
                    },
                    "schedule": {
                        "type": Sequelize.STRING,
                        "field": "schedule",
                        "allowNull": true
                    },
                    "max_turns": {
                        "type": Sequelize.INTEGER,
                        "field": "max_turns",
                        "defaultValue": 20,
                        "allowNull": false
                    },
                    "timeout_ms": {
                        "type": Sequelize.INTEGER,
                        "field": "timeout_ms",
                        "defaultValue": 300000,
                        "allowNull": false
                    },
                    "metadata": {
                        "type": Sequelize.JSON,
                        "field": "metadata",
                        "allowNull": true
                    },
                    "docker_image": {
                        "type": Sequelize.STRING,
                        "field": "docker_image",
                        "defaultValue": "ubuntu:22.04",
                        "allowNull": false
                    },
                    "created_at": {
                        "type": Sequelize.DATE,
                        "field": "created_at",
                        "allowNull": false
                    },
                    "updated_at": {
                        "type": Sequelize.DATE,
                        "field": "updated_at",
                        "allowNull": false
                    }
                },
                {
                    "transaction": transaction
                }
            ]
        },
        {
            fn: "createTable",
            params: [
                "AgentLogs",
                {
                    "id": {
                        "type": Sequelize.UUID,
                        "field": "id",
                        "primaryKey": true
                    },
                    "agent_id": {
                        "type": Sequelize.UUID,
                        "field": "agent_id",
                        "allowNull": false
                    },
                    "run_id": {
                        "type": Sequelize.UUID,
                        "field": "run_id",
                        "allowNull": true
                    },
                    "level": {
                        "type": Sequelize.STRING,
                        "field": "level",
                        "defaultValue": "info",
                        "allowNull": false
                    },
                    "event": {
                        "type": Sequelize.STRING,
                        "field": "event",
                        "allowNull": false
                    },
                    "message": {
                        "type": Sequelize.TEXT,
                        "field": "message",
                        "allowNull": false
                    },
                    "data": {
                        "type": Sequelize.JSON,
                        "field": "data",
                        "allowNull": true
                    },
                    "created_at": {
                        "type": Sequelize.DATE,
                        "field": "created_at",
                        "allowNull": false
                    }
                },
                {
                    "transaction": transaction
                }
            ]
        },
        {
            fn: "createTable",
            params: [
                "Runs",
                {
                    "id": {
                        "type": Sequelize.UUID,
                        "field": "id",
                        "primaryKey": true
                    },
                    "name": {
                        "type": Sequelize.STRING,
                        "field": "name",
                        "allowNull": true
                    },
                    "cwd": {
                        "type": Sequelize.STRING,
                        "field": "cwd",
                        "allowNull": false
                    },
                    "model": {
                        "type": Sequelize.STRING,
                        "field": "model",
                        "defaultValue": "claude-sonnet-4-20250514",
                        "allowNull": false
                    },
                    "total_input_tokens": {
                        "type": Sequelize.INTEGER,
                        "field": "total_input_tokens",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "total_output_tokens": {
                        "type": Sequelize.INTEGER,
                        "field": "total_output_tokens",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "total_cost_usd": {
                        "type": Sequelize.FLOAT,
                        "field": "total_cost_usd",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "agent_id": {
                        "type": Sequelize.UUID,
                        "field": "agent_id",
                        "allowNull": true
                    },
                    "trigger": {
                        "type": Sequelize.STRING,
                        "field": "trigger",
                        "allowNull": true
                    },
                    "run_summary": {
                        "type": Sequelize.TEXT,
                        "field": "run_summary",
                        "allowNull": true
                    },
                    "run_error": {
                        "type": Sequelize.TEXT,
                        "field": "run_error",
                        "allowNull": true
                    },
                    "created_at": {
                        "type": Sequelize.DATE,
                        "field": "created_at",
                        "allowNull": false
                    },
                    "updated_at": {
                        "type": Sequelize.DATE,
                        "field": "updated_at",
                        "allowNull": false
                    }
                },
                {
                    "transaction": transaction
                }
            ]
        },
        {
            fn: "createTable",
            params: [
                "Messages",
                {
                    "id": {
                        "type": Sequelize.UUID,
                        "field": "id",
                        "primaryKey": true
                    },
                    "run_id": {
                        "type": Sequelize.UUID,
                        "field": "run_id",
                        "allowNull": false
                    },
                    "role": {
                        "type": Sequelize.STRING,
                        "field": "role",
                        "allowNull": false
                    },
                    "seq": {
                        "type": Sequelize.INTEGER,
                        "field": "seq",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "content": {
                        "type": Sequelize.JSON,
                        "field": "content",
                        "allowNull": false
                    },
                    "stop_reason": {
                        "type": Sequelize.STRING,
                        "field": "stop_reason",
                        "allowNull": true
                    },
                    "input_tokens": {
                        "type": Sequelize.INTEGER,
                        "field": "input_tokens",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "output_tokens": {
                        "type": Sequelize.INTEGER,
                        "field": "output_tokens",
                        "defaultValue": 0,
                        "allowNull": false
                    },
                    "created_at": {
                        "type": Sequelize.DATE,
                        "field": "created_at",
                        "allowNull": false
                    }
                },
                {
                    "transaction": transaction
                }
            ]
        },
        {
            fn: "createTable",
            params: [
                "Folders",
                {
                    "id": {
                        "type": Sequelize.UUID,
                        "field": "id",
                        "primaryKey": true
                    },
                    "name": {
                        "type": Sequelize.STRING,
                        "field": "name",
                        "allowNull": false
                    },
                    "parent_id": {
                        "type": Sequelize.UUID,
                        "field": "parent_id",
                        "allowNull": true
                    },
                    "created_at": {
                        "type": Sequelize.DATE,
                        "field": "created_at",
                        "allowNull": false
                    },
                    "updated_at": {
                        "type": Sequelize.DATE,
                        "field": "updated_at",
                        "allowNull": false
                    }
                },
                {
                    "transaction": transaction
                }
            ]
        }
    ];
};
var rollbackCommands = function(transaction) {
    return [{
            fn: "dropTable",
            params: ["Agents", {
                transaction: transaction
            }]
        },
        {
            fn: "dropTable",
            params: ["AgentLogs", {
                transaction: transaction
            }]
        },
        {
            fn: "dropTable",
            params: ["Runs", {
                transaction: transaction
            }]
        },
        {
            fn: "dropTable",
            params: ["Messages", {
                transaction: transaction
            }]
        },
        {
            fn: "dropTable",
            params: ["Folders", {
                transaction: transaction
            }]
        }
    ];
};

module.exports = {
    pos: 0,
    useTransaction: true,
    execute: function(queryInterface, Sequelize, _commands)
    {
        var index = this.pos;
        function run(transaction) {
            const commands = _commands(transaction);
            return new Promise(function(resolve, reject) {
                function next() {
                    if (index < commands.length)
                    {
                        let command = commands[index];
                        console.log("[#"+index+"] execute: " + command.fn);
                        index++;
                        queryInterface[command.fn].apply(queryInterface, command.params).then(next, reject);
                    }
                    else
                        resolve();
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
    up: function(queryInterface, Sequelize)
    {
        return this.execute(queryInterface, Sequelize, migrationCommands);
    },
    down: function(queryInterface, Sequelize)
    {
        return this.execute(queryInterface, Sequelize, rollbackCommands);
    },
    info: info
};
