import parseArgs from "minimist"
import * as version from "./version"
import fs from "fs-extra"
import vm from "vm"
import path from "path"
import JSON5 from "@johnls/json5"
import autobind from "autobind-decorator"
import * as assertions from "./assertions"
import * as actions from "./actions"
import util, { SSH, SFTP, ScriptError } from "./utility"
import semver from "semver"

@autobind
export class ShovelTool {
  constructor(container = {}) {
    this.toolName = container.toolName
    this.fs = container.fs || fs
    this.log = container.log
    this.util = container.util || util
    this.assertions = container.assertions || assertions
    this.actions = container.actions || actions
    this.process = container.process || process
    this.createSsh = container.createSsh || ((options) => new SSH(options))
    this.createSftp = container.createSftp || ((options) => new SFTP(options))
    this.debug = container.debug
  }

  static minNodeVersion = "v10.17.0"
  static ltsNodeVersion = "v12.16.1"
  static npmPackageName = "@kingstonsoftware/shovel"

  async assertHasNode(ssh) {
    let result = await ssh.run("node --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 &&
      result.output.length > 0 &&
      semver.gte(semver.clean(result.output[0]), ShovelTool.minNodeVersion)
    )
  }

  async rectifyHasNode(ssh, sftp) {
    let result = null
    const nodeMajorVersion = semver.major(ShovelTool.ltsNodeVersion)
    const installNodeScript = `#!/bin/bash
    echo "> Installing Node.js"
    VERSION=$(grep -Eo "\\(Red Hat|\\(Ubuntu" /proc/version)
    case $VERSION in
      "(Red Hat")
        curl -sL https://rpm.nodesource.com/setup_${nodeMajorVersion}.x | bash -
        yum clean all
        yum makecache fast
        yum install -y -q gcc-c++ make
        yum install -y -q nodejs
        ;;
      "(Ubuntu")
        curl -sL https://deb.nodesource.com/setup_${nodeMajorVersion}.x | bash -
        apt update
        apt install -y -q g++ make
        apt install -y -q nodejs
        ;;
      *)
        echo Unsupported Linux distro
        exit 255
        ;;
    esac
  `

    this.log.info("Checking remote system clock")
    result = await ssh.run('bash -c "echo /$(date)"', {
      noThrow: true,
    })

    if (
      result.exitCode !== 0 ||
      result.output.length === 0 ||
      !result.output[0].startsWith("/")
    ) {
      throw new Error("Unable to get remote host date & time")
    }

    const remoteDate = new Date(result.output[0].substring(1))
    const localDate = new Date()

    if (
      remoteDate.getFullYear() !== localDate.getFullYear() ||
      remoteDate.getMonth() !== localDate.getMonth() ||
      remoteDate.getDate() !== localDate.getDate()
    ) {
      throw new Error("Remote system clock is more than 24 hours out of sync.")
    }

    const remoteTempFilePath = (await ssh.run("mktemp")).output[0]

    this.log.info(
      `Created remote Node.js install script${
        this.debug ? " (" + remoteTempFilePath + ")" : ""
      }`
    )

    await sftp.putContent(installNodeScript, remoteTempFilePath)

    this.log.info(`Running Node.js install script; this could take a while`)

    result = await ssh.run(`bash ${remoteTempFilePath}`, {
      sudo: true,
      noThrow: true,
      startSpinner: this.log.startSpinner,
      stopSpinner: this.log.stopSpinner,
    })

    this.log.stopSpinner()

    if (result.exitCode === 0) {
      result = await ssh.run("node --version", {
        noThrow: true,
      })

      if (
        result.exitCode === 0 &&
        result.output[0] &&
        semver.eq(semver.clean(result.output[0]), ShovelTool.ltsNodeVersion)
      ) {
        return
      }
    }

    throw new Error(
      `Unable to install Node.js ${ShovelTool.ltsNodeVersion} on remote host`
    )
  }

  async assertHasShovel(ssh) {
    let result = await ssh.run("shovel --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 &&
      result.output.length > 0 &&
      semver.gte(semver.clean(result.output[0]), version.shortVersion)
    )
  }

  async rectifyHasShovel(ssh) {
    this.log.info("Installing Shovel")

    // NOTE: See https://github.com/nodejs/node-gyp/issues/454#issuecomment-58792114 for why "--unsafe-perm"
    let result = await ssh.run(
      `bash -c "echo '> Installing Shovel' && npm install --quiet --no-progress --unsafe-perm -g ${ShovelTool.npmPackageName}"`,
      {
        sudo: true,
        noThrow: true,
        startSpinner: this.log.startSpinner,
        stopSpinner: this.log.stopSpinner,
      }
    )

    this.log.stopSpinner()

    if (result.exitCode === 0) {
      result = await ssh.run("shovel --version", {
        noThrow: true,
      })

      if (
        result.exitCode === 0 &&
        result.output[0].startsWith(version.shortVersion)
      ) {
        return
      }
    }

    throw new Error(
      `Unable to install Shovel ${version.shortVersion} on remote host`
    )
  }

  async loadScriptFile(scriptPath) {
    const scriptNode = JSON5.parse(await this.fs.readFile(scriptPath), {
      wantNodes: true,
    })
    const createArrayNode = () => ({
      line: 0,
      column: 0,
      type: "array",
      value: [],
    })
    const createObjectNode = () => ({
      line: 0,
      column: 0,
      type: "object",
      value: {},
    })
    const addFilename = (node) => {
      node.filename = scriptPath

      switch (node.type) {
        case "null":
        case "number":
        case "boolean":
          break
        case "object":
          for (const [key, value] of Object.entries(node.value)) {
            addFilename(value)
          }
          break
        case "array":
          for (const value of node.value) {
            addFilename(value)
          }
          break
      }
    }

    if (scriptNode.type !== "object") {
      throw new ScriptError(
        "Script must have an object as the root",
        scriptNode
      )
    }

    let {
      includes: includesNode,
      metadata: metadataNode,
      vars: varsNode,
      statements: statementsNode,
    } = scriptNode.value

    if (!includesNode) {
      scriptNode.value.includes = includesNode = createArrayNode()
    }

    if (!metadataNode) {
      scriptNode.value.metadata = metadataNode = createObjectNode()
    }

    if (!varsNode) {
      scriptNode.value.vars = varsNode = createObjectNode()
    }

    if (!statementsNode) {
      scriptNode.value.statements = statementsNode = createArrayNode([])
    }

    addFilename(scriptNode)

    if (includesNode.type !== "array") {
      throw new ScriptError("'include' must be an array", includesNode)
    }

    for (const includeNode of includesNode.value) {
      if (includeNode.type !== "string") {
        throw new ScriptError("Include must be a string", includeNode)
      }

      if (path.isAbsolute(includeNode.value)) {
        throw new ScriptError(
          "Absolute path for include is not allowed",
          includeNode
        )
      }
    }

    if (metadataNode.type !== "object") {
      throw new ScriptError("'metadata' must be an object", metadataNode)
    }

    const { description: descriptionNode } = metadataNode.value

    if (descriptionNode && descriptionNode.type !== "string") {
      throw new ScriptError("'description' must be a string", descriptionNode)
    }

    if (varsNode.type !== "object") {
      throw new ScriptError("'vars' must be an object", varsNode)
    }

    if (statementsNode.type !== "array") {
      throw new ScriptError("'statements' must be an array", statementsNode)
    }

    for (const statementNode of statementsNode.value) {
      if (statementNode.type !== "object") {
        throw new ScriptError("Assertion must be an object", statementNode)
      }

      const {
        description: descriptionNode,
        when: whenNode,
        action: actionNode,
        assert: assertNode,
        with: withNode,
      } = statementNode.value

      if (assertNode) {
        if (assertNode.type !== "string") {
          throw new ScriptError("'assert' must be a string", assertNode)
        }
      } else if (actionNode) {
        if (actionNode.type !== "string") {
          throw new ScriptError("'action' must be a string", actionNode)
        }
      } else {
        throw new ScriptError(
          "Neither assert' or 'action' property is present",
          statementNode
        )
      }

      if (descriptionNode && descriptionNode.type !== "string") {
        throw new ScriptError("'description' must be a string", descriptionNode)
      }

      if (
        whenNode &&
        !(whenNode.type === "string" || whenNode.type === "boolean")
      ) {
        throw new ScriptError("'when' must be a string or boolean", whenNode)
      }

      if (!withNode || withNode.type !== "object") {
        throw new ScriptError(
          "'with' must be present and of type 'object'",
          statementNode
        )
      }
    }

    return scriptNode
  }

  async createScriptContext(rootScriptPath) {
    const scriptNodes = new Map()
    const scriptPaths = []
    let anyScriptHasBecomes = false

    const loadScriptNode = async (
      includeNode,
      scriptDirPath,
      scriptFilePath
    ) => {
      const fromRootScriptFilePath = path.join(
        path.relative(rootScriptDirPath, scriptDirPath),
        scriptFilePath
      )

      if (includeNode && fromRootScriptFilePath.startsWith(".")) {
        throw new ScriptError(
          `Cannot include script from a directory below root script directory '${rootScriptDirPath}'`,
          includeNode
        )
      }

      if (!scriptNodes.has(fromRootScriptFilePath)) {
        const scriptNode = await this.loadScriptFile(
          path.resolve(scriptDirPath, scriptFilePath)
        )

        scriptNodes.set(fromRootScriptFilePath, scriptNode)

        anyScriptHasBecomes =
          anyScriptHasBecomes ||
          !!scriptNode.value.statements.value.find((statementNode) =>
            statementNode.value.hasOwnProperty("become")
          )

        for (var includeNode of scriptNode.value.includes.value) {
          const includeFilePath = path.join(scriptDirPath, includeNode.value)

          await loadScriptNode(
            includeNode,
            path.dirname(includeFilePath),
            path.basename(includeFilePath)
          )
        }
      }

      scriptPaths.push(fromRootScriptFilePath)
    }

    const rootScriptDirPath = path.dirname(rootScriptPath)

    await loadScriptNode(null, rootScriptDirPath, path.basename(rootScriptPath))

    return {
      rootScriptDirPath,
      scriptNodes,
      scriptPaths,
      anyScriptHasBecomes,
    }
  }

  async createRunContext() {
    const osInfo = await this.util.osInfo()
    const runContext = vm.createContext({
      vars: {},
      env: Object.assign({}, this.process.env),
      os: osInfo,
      user: this.util.userInfo(),
      sys: {},
      fs: {
        readFile: (fileName) =>
          this.fs.readFileSync(fileName, { encoding: "utf8" }),
      },
      path: {
        join: (...pathNames) => path.join(...pathNames),
        dirname: (pathName) => path.dirname(pathName),
        basename: (pathName, ext) => path.basename(pathName, ext),
        extname: (pathName) => path.extname(pathName),
      },
      dateTime: {
        asLocal: (dateTime) =>
          (dateTime ? new Date(dateTime) : new Date()).toString(),
        asISO: (dateTime) =>
          (dateTime ? new Date(dateTime) : new Date()).toISOString(),
      },
      util: {
        template: (s, a = "{{", b = "}}") =>
          s.replace(new RegExp(a + ".*?" + b, "gm"), (m, offset) => {
            try {
              return new vm.Script(m).runInContext(runContext).toString()
            } catch (e) {
              throw new Error(
                `Template expression at offset ${offset}. ${e.message}`
              )
            }
          }),
      },
      results: [],
    })
    // TODO: Create isScriptNode() that checks for string {}'s
    const interpolator = (node) => {
      if (!node.type || node.type !== "string") {
        throw new Error("Can only interpolate string nodes")
      }

      if (node.value.startsWith("{") && node.value.endsWith("}")) {
        try {
          return new vm.Script(node.value).runInContext(runContext)
        } catch (e) {
          throw new ScriptError(`Bad script. ${e.message}`, node)
        }
      } else {
        return node.value
      }
    }

    runContext.results.last = function () {
      return this[this.length - 1]
    }

    return { runContext, interpolator }
  }

  updateRunContext(runContext, interpolator, scriptNode, options = {}) {
    const interpolateObjectNode = (vars, node, withInterpolation) => {
      Object.entries(node.value).forEach(([k, v]) => {
        if (v.type === "object") {
          if (!vars[k] || typeof vars[k] !== "object") {
            vars[k] = {}
          }
          interpolateObjectNode(
            vars[k],
            v,
            k === "local" && vars === runContext.vars ? true : withInterpolation
          )
        } else if (v.type === "array") {
          if (!vars[k] || !Array.isArray(vars[k])) {
            vars[k] = []
          }
          interpolateArrayNode(vars[k], v, withInterpolation)
        } else {
          vars[k] =
            v.type === "string" && withInterpolation ? interpolator(v) : v.value
        }
      })
    }
    const interpolateArrayNode = (vars, node, withInterpolation) => {
      node.value.forEach((v, i) => {
        if (v.type === "object") {
          if (!vars[i] || typeof vars[i] !== "object") {
            vars[i] = {}
          }
          interpolateObjectNode(vars[i], v, withInterpolation)
        } else if (v.type === "array") {
          if (!vars[i] || !Array.isArray(vars[i])) {
            vars[i] = []
          }
          interpolateArrayNode(vars[i], v, withInterpolation)
        } else {
          vars[i] =
            v.type === "string" && withInterpolation ? interpolator(v) : v.value
        }
      })
    }

    Object.assign(runContext.sys, {
      scriptFile: scriptNode.filename,
      scriptDir: path.dirname(scriptNode.filename),
    })

    const { vars: varsNode } = scriptNode.value

    // Process vars in a way that merges with existing and allows back references
    interpolateObjectNode(
      runContext.vars,
      varsNode,
      !!!options.interpolateOnlyLocalVars
    )
  }

  async runScriptLocally(rootScriptPath, options = {}) {
    const scriptContext = await this.createScriptContext(rootScriptPath)
    let sudo = null

    if (!options.noSpinner) {
      this.log.enableSpinner()
    }

    if (scriptContext.anyScriptHasBecomes) {
      if (!this.util.runningAsRoot()) {
        throw new Error(
          "Script or included script requires becoming another user and it is not running as root"
        )
      }

      sudo = {
        uid: parseInt(this.process.env["SUDO_UID"]),
        gid: parseInt(this.process.env["SUDO_GID"]),
      }

      this.process.setegid(sudo.gid)
      this.process.seteuid(sudo.uid)
    }

    let { runContext, interpolator } = await this.createRunContext()

    for (var scriptPath of scriptContext.scriptPaths) {
      const scriptNode = scriptContext.scriptNodes.get(scriptPath)

      this.updateRunContext(runContext, interpolator, scriptNode)

      if (this.debug && Object.keys(runContext.vars).length > 0) {
        this.log.debug("Current variables:")
        this.log.debug(JSON5.stringify(runContext.vars, null, "  "))
      }

      const {
        statements: statementsNode,
        metadata: metadataNode,
      } = scriptNode.value

      // Show metadata if there is any
      if (Object.keys(metadataNode.value).length > 0) {
        this.log.output(
          JSON5.stringify(
            JSON5.simplify(metadataNode),
            null,
            this.debug ? "  " : null
          )
        )
      }

      this.log.info(`Running '${scriptPath}'`)

      for (const statementNode of statementsNode.value) {
        const {
          assert: assertNode,
          action: actionNode,
          when: whenNode,
          become: becomeNode,
          description: descriptionNode,
        } = statementNode.value

        if (whenNode) {
          if (
            (whenNode.type === "boolean" && !whenNode.value) ||
            (whenNode.type === "string" && !Boolean(interpolator(whenNode)))
          ) {
            continue
          }
        }

        if (becomeNode && becomeNode.value) {
          this.process.setegid(0)
          this.process.seteuid(0)
        } else if (sudo !== null) {
          this.process.setegid(sudo.gid)
          this.process.seteuid(sudo.uid)
        }

        let result = {}

        if (assertNode) {
          const Assertion = this.assertions[assertNode.value]

          if (!Assertion) {
            throw new ScriptError(
              `${assertNode.value} is not a valid assertion`,
              statementNode
            )
          }

          const assertion = new Assertion({
            interpolator,
            runContext,
          })

          this.log.startSpinner(assertNode.value)

          if (!(await assertion.assert(statementNode))) {
            if (options.assertOnly) {
              result.wouldRectify = assertNode.value
            } else {
              await assertion.rectify()
              result.rectified = assertNode.value
            }
          } else {
            result.asserted = assertNode.value
          }

          Object.assign(result, assertion.result())
        } else {
          const Action = this.actions[actionNode.value]

          if (!Action) {
            throw new ScriptError(
              `${actionNode.value} is not a valid action`,
              actionNode
            )
          }

          this.log.startSpinner(actionNode.value)

          const action = new Action({ interpolator, runContext })

          await action.perform()

          Object.assign(result, action.result())
        }

        if (descriptionNode) {
          result.description = descriptionNode.value
        }

        runContext.results.push(result)

        this.log.output(JSON5.stringify(result, null, this.debug ? "  " : null))
      }

      if (sudo !== null) {
        this.process.setegid(sudo.gid)
        this.process.seteuid(sudo.uid)
      }
    }
  }

  async runScriptRemotely(rootScriptPath, options) {
    const scriptContext = await this.createScriptContext(rootScriptPath)

    if (!options.noSpinner) {
      this.log.enableSpinner()
    }

    // Things that need to be accessed in finally
    let ssh = null
    let sftp = null
    let remoteTempDir = null

    try {
      this.log.info(`Connecting to ${options.host}`)

      ssh = this.createSsh({ debug: options.sshDebug })

      const connectOptions = {
        host: options.host,
        port: options.port,
        user: options.user,
        identity: options.identity,
      }

      await ssh.connect(connectOptions)

      sftp = this.createSftp({ debug: options.sftpDebug })

      await sftp.connect(
        Object.assign(connectOptions, {
          loginPasswordPrompts: ssh.loginPasswordPrompts,
        })
      )

      const hasNode = await this.assertHasNode(ssh)
      const hasShovel = hasNode && (await this.assertHasShovel(ssh))

      if (!hasNode) {
        this.log.warning(`Node not found; attempting to rectify.`)
        await this.rectifyHasNode(ssh, sftp)
      }

      if (!hasShovel) {
        this.log.warning(
          `Shovel with version ${version.shortVersion} not found; attempting to rectify`
        )
        await this.rectifyHasShovel(ssh)
      }

      remoteTempDir = (await ssh.run("mktemp -d")).output[0]

      if (this.debug) {
        this.log.debug(`Created remote script directory '${remoteTempDir}'`)
      }

      let { runContext, interpolator } = await this.createRunContext()

      const remoteScriptDirs = new Set()

      for (const scriptPath of scriptContext.scriptPaths) {
        const scriptNode = scriptContext.scriptNodes.get(scriptPath)

        this.updateRunContext(runContext, interpolator, scriptNode, {
          interpolateOnlyLocalVars: true,
        })

        const newScript = JSON5.simplify(scriptNode)

        newScript.vars = runContext.vars

        const scriptContent = JSON5.stringify(
          newScript,
          null,
          this.debug ? "  " : null
        )

        const remoteScriptPath = path.join(remoteTempDir, scriptPath)
        const remoteScriptDir = path.dirname(remoteScriptPath)

        if (!remoteScriptDirs.has(remoteScriptDir)) {
          await ssh.run(`mkdir -p ${remoteScriptDir}`)
          remoteScriptDirs.add(remoteScriptDir)
        }

        await sftp.putContent(scriptContent, remoteScriptPath)

        if (this.debug) {
          this.log.debug(`Uploaded ${remoteScriptPath}:`)
          scriptContent.split(/\n/g).forEach((line, i) => {
            this.log.debug(
              i.toString().padStart(3, " ") + ": " + line.trimEnd()
            )
          })
        }
      }

      const remoteRootScriptPath = path.join(
        remoteTempDir,
        scriptContext.scriptPaths[scriptContext.scriptPaths.length - 1]
      )

      this.log.info(
        `Running script on host${
          scriptContext.anyScriptHasBecomes ? " as root" : ""
        } `
      )

      await ssh.run(
        `shovel --noSpinner${
          options.assertOnly ? " --assertOnly " : " "
        } ${remoteRootScriptPath} `,
        {
          sudo: scriptContext.anyScriptHasBecomes,
          logOutput: this.log.output,
          logError: this.log.outputError,
          startSpinner: this.log.startSpinner,
          stopSpinner: this.log.stopSpinner,
          noThrow: true,
        }
      )
    } finally {
      if (remoteTempDir) {
        if (this.debug) {
          this.log.info(`Deleting remote script directory '${remoteTempDir}'`)
        }

        await ssh.run(`rm -rf ${remoteTempDir}`)
      }

      if (sftp) {
        sftp.close()
      }

      ssh.close()
      this.log.info(`Disconnected from ${options.host}`)
    }
  }

  async run(argv) {
    const badArgs = new Set()
    const options = {
      boolean: [
        "help",
        "version",
        "debug",
        "assertOnly",
        "noSpinner",
        "sshDebug",
        "sftpDebug",
      ],
      string: ["host", "hostFile", "user", "port", "identity"],
      alias: {
        a: "assertOnly",
        f: "hostFile",
        h: "host",
        i: "identity",
        p: "port",
        u: "user",
        d: "debug",
      },
      unknown: (arg) => {
        if (arg.startsWith("-")) {
          badArgs.add(arg)
          return false
        } else {
          return true
        }
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${version.fullVersion}`)
      return
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [options] <script-file>

Description:

Runs a Shovel configuration script.If 'host' or 'hostFile' argument
is given then the script will be run on those hosts using SSH. If not
then the script will be run directly on the machine without SSH.

Node.js and Shovel will be installed on the remote hosts if not already
present. For installation to work the SSH user must have sudo
permissions on the host. If passwords are required for login or
sudo the tool will prompt for them.

Arguments:
  --help                  Shows this help
  --version               Shows the tool version
  --host, -h <host>       Remote host name.Default is to run the script
                          directly on the local system
  --port, -p <port>       Remote port number; default is 22
  --user, -u <user>       Remote user name; defaults to current user
  --identity, -i <key>    User identity file
  --hostFile, -f <file>   JSON5 file containing multiple host names
  --assertOnly, -a        Only run statements, don't rectify
  --noSpinner             Disable spinner animation
  --debug                 Show script related debugging output
  --sshDebug              Show SSH related debugging output
  --sftpDebug             Show SFTP related debugging output
`)
      return
    }

    if (badArgs.size > 0) {
      for (const arg of badArgs) {
        this.log.warning(`Argument '${arg}' is not recognized`)
      }
    }

    if (args._.length === 0) {
      throw new Error("Please specify a script file")
    } else if (args._.length > 1) {
      throw new Error("Please specify only one script file")
    }

    const scriptPath = path.resolve(args._[0])

    if (
      (args.port || args.user || args.identity) &&
      !args.host &&
      !args.hostFile
    ) {
      throw new Error(
        "'host' or 'hostFile' must be specified with 'port', 'user', 'identity' and arguments"
      )
    }

    let hosts = null

    if (args.host || args.hostFile) {
      hosts = []

      if (args.hostFile) {
        hosts = hosts.concat(JSON5.parse(await this.fs.readFile(args.hostFile)))
      }

      if (args.host) {
        hosts.push({
          host: args.host,
          port: this.util.parsePort(args.port),
          user: args.user,
          identity: args.identity,
        })
      }
    }

    if (hosts) {
      let failures = 0

      for (const host of hosts) {
        try {
          await this.runScriptRemotely(scriptPath, {
            host: host.host,
            port: this.util.parsePort(host.port),
            user: host.user,
            identity: host.identity,
            assertOnly: args.assertOnly,
            sshDebug: args.sshDebug,
            sftpDebug: args.sftpDebug,
          })
        } catch (error) {
          this.log.error(error.message)
          failures += 1
        }
      }

      if (failures > 0) {
        throw new Error(`${failures} hosts were not updated`)
      }
    } else {
      await this.runScriptLocally(scriptPath, {
        noSpinner: args.noSpinner,
        assertOnly: args.assertOnly,
      })
    }
  }
}
