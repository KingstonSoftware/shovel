import fs from "fs-extra"
import childProcess from "child_process"
import * as util from "./util"
import os from "os"

/*
Asserts and ensures that a group exists.

Example:

{
  assert: "GroupExists",
  with: {
    name: "string",
  }
}
*/

// TODO: Support {gid: "number"}

export class GroupExists {
  constructor(container) {
    this.fs = container.fs || fs
    this.childProcess = container.childProcess || childProcess
    this.os = container.os || os
    this.newScriptError = container.newScriptError
    this.expandString = container.expandString
    this.withNode = container.withNode
    this.assertNode = container.assertNode
  }

  async assert(args) {
    this.args = args

    const { name: nameNode } = args

    if (!nameNode || nameNode.type !== "string") {
      throw this.newScriptError(
        "'name' must be supplied and be a string",
        nameNode || this.withNode
      )
    }

    this.expandedName = this.expandString(nameNode.value)

    return (await this.fs.readFile("/etc/groups")).includes(
      this.expandedName + ":"
    )
  }

  async actualize() {
    const { name: nameNode } = this.args

    if (!util.runningAsRoot(this.os)) {
      throw this.newScriptError(
        "Only root user can add or modify groups",
        this.assertNode
      )
    }

    await this.childProcess.exec(`groupadd ${this.expandedName}`)
  }

  result() {
    return { name: this.expandedName }
  }
}
