import parseArgs from "minimist"
import { fullVersion } from "./version"
import readlinePassword from "@johnls/readline-password"
import SSH2Promise from "ssh2-promise"
import os from "os"
import autobind from "autobind-decorator"

const commandComplete = (socket, password) => {
  return new Promise((resolve, reject) => {
    let err = ""
    let out = ""
    socket
      .on("close", () => resolve({ out, err }))
      .on("error", reject)
      .on("data", (data) => {
        out += data
      }) // We have to read any data or the socket will block
      .stderr.on("data", (data) => {
        err += data
      })

    if (password) {
      socket.write(password + "\n")
      socket.end()
    }
  })
}

@autobind
export class OctopusTool {
  constructor(toolName, log, options) {
    options = options || {}
    this.toolName = toolName
    this.log = log
    this.debug = options.debug
  }

  static installNodeScript = `#!/bin/bash
curl -sL https://deb.nodesource.com/setup_10.x -o ./nodesource_setup.sh
sudo bash ./nodesource_setup.sh
sudo apt -y -q install nodejs`

  // Assert the remote system has Node 10 installed
  async assertHasNode(ssh) {
    let output = null

    try {
      output = await ssh.exec("node --version")
    } catch (error) {
      return false
    }

    return output.trim().startsWith("v10")
  }

  async rectifyHasNode(ssh) {
    const password = ssh.config[0].password
    let stream = null

    try {
      this.log.info("Creating /opt/octopus directory")
      stream = await ssh.spawn("sudo mkdir -p /opt/octopus", null, {
        pty: !!password,
      })
      await commandComplete(stream, password)
    } catch (error) {
      throw new Error("Unable to create /opt/octopus directory on remote")
    }

    try {
      this.log.info("Creating /opt/octopus/install_node.sh script")
      stream = await ssh.spawn(
        `cd /opt/octopus 1> /dev/null 2> /dev/null; sudo bash -c 'echo "${
          OctopusTool.installNodeScript
        }" > ./install_node.sh'`,
        null,
        { pty: !!password }
      )
      await commandComplete(stream, password)
    } catch (error) {
      throw new Error("Unable to create install_node.sh file")
    }

    try {
      this.log.info("Running /opt/octopus/install_node.sh script")
      stream = await ssh.spawn(
        "cd /opt/octopus 1> /dev/null 2> /dev/null; sudo bash ./install_node.sh",
        null,
        { pty: !!password }
      )
      await commandComplete(stream, password)
    } catch (error) {
      throw new Error("Unsuccessful running install_node.sh")
    }

    if (!this.assertHasNode(ssh)) {
      throw new Error("Node installation failed")
    }
  }

  async assertHasOctopus() {
    let output = null

    try {
      output = await ssh.exec("octopus --version")
    } catch (error) {
      return false
    }

    return output.trim().startsWith(version.fullVersion)
  }

  async rectifyHasOctopus() {}

  async runScriptOnHost(options) {
    let isConnected = false
    let ssh = null
    const showPrompts = async (name, instructions, lang, prompts) => {
      const rl = readlinePassword.createInstance(process.stdin, process.stdout)
      let responses = []

      for (const prompt of prompts) {
        responses.push(await rl.passwordAsync(prompt))
      }
      rl.close()
      return responses
    }

    try {
      const userInfo = os.userInfo()
      const sshConfig = {
        username: options.user || userInfo.username,
        host: options.host || "localhost",
        port: options.port || 22,
        password: options.password,
        agent: process.env["SSH_AUTH_SOCK"],
        showPrompts,
        // debug: this.debug ? (detail) => this.log.info(detail) : null,
      }

      this.log.info(
        `Connecting to ${sshConfig.host}:${sshConfig.port} as ${
          sshConfig.username
        }`
      )

      if (!sshConfig.password) {
        const answers = await showPrompts("", "", "en-us", [
          {
            prompt: `${sshConfig.username}:${sshConfig.host}'s password:`,
            echo: false,
          },
        ])

        sshConfig.password = answers[0]
      }

      ssh = new SSH2Promise(sshConfig)

      await ssh.connect()

      isConnected = true

      this.log.info(
        `Connected to '${sshConfig.username}@${sshConfig.host}:${
          sshConfig.port
        }'`
      )

      if (!(await this.assertHasNode(ssh))) {
        this.log.warning(
          `Node not found on '${sshConfig.host}'; attempting to rectify.`
        )
        await this.rectifyHasNode(ssh)
      } else {
        this.log.info(`Node is installed on '${sshConfig.host}'`)
      }

      // TODO: Run mktemp remotely and capture file name
      // TODO: Create SFTP connection
      // TODO: Copy script to remote temp file
      // TODO: Run Octopus remotely and capture output
    } finally {
      // TODO: Close SFTP connection if necessary
      if (isConnected) {
        ssh.close()
        this.log.info(
          `Disconnected from '${ssh.config[0].host}:${ssh.config[0].port}'`
        )
      }

      process.stdin.unref() // To free the Node event loop
    }
  }

  async processScriptFile(options) {
    const { scriptFileName, scriptNodes, verbose } = options
    const newScriptError = (message, node) => {
      return new ScriptError(message, scriptFileName, node)
    }

    if (scriptNodes.type !== "object") {
      throw newScriptError(
        "Script must have an object as the root",
        scriptNodes
      )
    }

    // This is the execution context that holds execution state
    const context = {
      vars: { ...process.env },
    }

    const {
      options: optionsNode,
      variables: varsNode,
      assertions: assertionsNode,
    } = scriptNodes.value

    if (optionsNode) {
      if (optionsNode.type !== "object") {
        throw newScriptError("'options' must be an object", optionsNode)
      }

      const { description: descriptionNode } = optionsNode.value

      if (descriptionNode) {
        if (descriptionNode.type !== "string") {
          throw newScriptError(
            "'options.description' must be a string",
            descriptionNode
          )
        }

        context.description = descriptionNode.value
        this.log.info(`Script: ${context.description}`)
      }
    }

    if (varsNode) {
      if (varsNode.type !== "object") {
        throw newScriptError("'variables' must be an object", varsNode)
      }

      for (const [key, value] of Object.entries(varsNode.value)) {
        switch (value.type) {
          case "null":
            delete context.vars[key]
            break
          case "numeric":
          case "boolean":
            context.vars[key] = value.value.toString()
            break
          case "string":
            context.vars[key] = value.value
            break
          default:
            throw newScriptError(
              `Variable of type ${value.type} is invalid`,
              value
            )
        }
      }
    }

    if (verbose) {
      this.log.info(JSON5.stringify(context.vars, null, "  "))
    }

    if (!assertionsNode) {
      this.log.warn("No 'assertions' found")
      return
    }

    if (assertionsNode.type !== "array") {
      throw newScriptError("'assertions' must be an array", assertionsNode)
    }

    context.assertions = []

    for (const assertionNode of assertionsNode.value) {
      if (assertionNode.type !== "object") {
        throw newScriptError("Assertion must be an object", assertionNode)
      }

      const assertion = {}
      const {
        description: descriptionNode,
        assert: assertNode,
        with: withNode,
      } = assertionNode.value

      assertion.assertNode = assertNode
      assertion.withNode = withNode

      if (assertNode) {
        if (assertNode.type !== "string") {
          throw newScriptError(
            "Assertion 'assert' must be a string",
            assertNode
          )
        }
        assertion.name = assertNode.value
      } else {
        throw newScriptError("Assertion has no 'assert' value", assertNode)
      }

      if (descriptionNode) {
        if (descriptionNode.type !== "string") {
          throw newScriptError(
            "Assertion 'description' must be a string",
            descriptionNode
          )
        }
        assertion.description = descriptionNode.value
      }

      if (withNode) {
        if (withNode.type !== "object") {
          throw newScriptError("Assertion 'with' must be an object", withNode)
        }

        assertion.args = withNode.value
      }

      context.assertions.push(assertion)
    }

    const scriptContext = vm.createContext(context.vars)
    const expandString = (s) =>
      new vm.Script("`" + s + "`").runInContext(scriptContext)

    for (const assertion of context.assertions) {
      const asserter = new asserters[assertion.name]({
        newScriptError,
        expandString,
        assertNode: assertion.assertNode,
        withNode: assertion.withNode,
      })

      let ok = null

      try {
        ok = await asserter.assert(assertion.args)
      } catch (e) {
        this.log.error(e)
        return 1
      }

      if (!ok) {
        try {
          await asserter.rectify()
        } catch (e) {
          this.log.error(e)
          return 1
        }
        this.log.rectified(assertion.name, asserter.result())
      } else {
        this.log.asserted(assertion.name, asserter.result())
      }
    }

    return 0
  }

  async run(argv) {
    const options = {
      boolean: ["help", "version", "debug"],
      string: ["host", "host-file", "user", "port", "password", "set"],
      alias: {
        h: "host",
        u: "user",
        p: "port",
        f: "host-file",
        P: "password",
        s: "set",
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${fullVersion}`)
      return 0
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [options] <script-file>

Description:

Runs an Octopus configuration script. If a host or host-file file is
given then the script will be run on those hosts using SSH. Node.js
and Octopus will be installed on the remote hosts if it is not already
present.  For this to work the given user must have sudo privileges on
the remote host.

Options:
  --help              Shows this help
  --version           Shows the tool version
  --host, -h          Remote host name. Default is to run the script
                      directly, without a remote proxy
  --port, -p          Remote port number. Default is 22
  --proxy-port, -pp   Remote proxy port. Defaults to 9000
  --user, -u          Remote user name. Defaults to current user.
  --password, -P      Remote user password. Defaults is to just use PPK.
  --host-file, -f     JSON5 file containing multiple remote host names
  --verbose           Emit verbose output
  --set,-s            Set one or more variables
`)
      return 0
    }

    const scriptFile = args._[0]

    if (!scriptFile) {
      throw new Error("Please specify a script file")
    }

    const port = parseInt(args.port)

    if (args.port && (port < 0 || port > 65535)) {
      throw new Error("Port must be a number between 0 and 65535")
    }

    if (args.host || args["host-file"]) {
      // TODO: Iterate through all the host in host-file
      return this.runScriptOnHost({
        scriptFile,
        host: args.host,
        user: args.user,
        password: args.password,
        port: port,
        proxyPort: args.proxyPort,
        verbose: args.verbose,
      })
    } else {
      const scriptNodes = JSON5.parse(await fs.readFile(scriptFile), {
        wantNodes: true,
      })

      // return this.processScriptFile({
      //   scriptFileName,
      //   scriptNodes,
      //   verbose: args.verbose,
      // })
    }
  }
}
