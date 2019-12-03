import childProcess from "child-process-promise"
import util from "../util"
import path from "path"
import { ScriptError } from "../ScriptError"

export class AutoToolProjectMade {
  constructor(container) {
    this.childProcess = container.childProcess || childProcess
    this.util = container.util || util
    this.expandStringNode = container.expandStringNode
  }

  async assert(assertNode) {
    const withNode = assertNode.value.with
    const { directory: directoryNode, args: argsNode } = withNode.value

    this.assertNode = assertNode

    if (!directoryNode || directoryNode.type !== "string") {
      throw new ScriptError(
        "'directory' must be supplied and be a string",
        directoryNode || withNode
      )
    }

    this.expandedDirectory = this.expandStringNode(directoryNode)

    if (argsNode) {
      if (argsNode.type !== "string") {
        throw new ScriptError("'args' must be a string", argsNode)
      }
      this.expandedTarget = this.expandStringNode(argsNode)
    } else {
      this.expandedTarget = ""
    }

    const makeFile = path.join(this.expandedDirectory, "Makefile")
    const pathInfo = await this.util.pathInfo(makeFile)

    if (!pathInfo.getAccess().isReadable()) {
      throw new ScriptError(`'${makeFile}' not found`, directoryNode)
    }

    try {
      await this.childProcess.exec(`make -q ${this.expandedTarget}`, {
        cwd: this.expandedDirectory,
      })
    } catch (e) {
      // TODO: Research if all autotools packages return exit code > 1 for the out-of-date state
      if (e.code > 1) {
        return false
      }
    }

    return true
  }

  async rectify() {
    const command = `make ${this.expandedTarget}`

    try {
      await this.childProcess.exec(command, {
        cwd: this.expandedDirectory,
      })
    } catch (e) {
      throw new ScriptError(
        `'${command}' failed. ${e.message}`,
        this.assertNode
      )
    }
  }

  result() {
    return { directory: this.expandedDirectory, args: this.expandedTarget }
  }
}