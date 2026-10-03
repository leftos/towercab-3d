/**
 * JSX nesting guard
 *
 * React logs "In HTML, <button> cannot be a descendant of <button>" in development
 * when a <button> renders inside another <button>, and the browser's HTML parser
 * may split them apart. No build step catches it, so this static scan parses every
 * renderer component with the TypeScript compiler API and asserts that no intrinsic
 * <button> sits inside another intrinsic <button>.
 *
 * A `.map((item) => <button>…)` callback inside a JSX child counts: the render
 * tree still nests one button in another. Only a function that is not itself
 * inside a JSX expression starts a fresh tree.
 */

import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = path.resolve(process.cwd(), 'src/renderer')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** The tag name of a JSX element or self-closing element, else null. */
function jsxTagName(node: ts.Node): string | null {
  const element = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null
  return element ? element.tagName.getText() : null
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
}

/** True when the node sits anywhere inside a JSX expression or element. */
function isInsideJsx(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isJsxElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxFragment(parent) ||
      ts.isJsxExpression(parent) ||
      ts.isJsxAttribute(parent)
    ) {
      return true
    }
  }
  return false
}

function collectHits(file: string, source: ts.SourceFile): string[] {
  const hits: string[] = []
  const relative = path.relative(RENDERER_ROOT, file).split(path.sep).join('/')

  function visit(node: ts.Node, openButtons: number[]): void {
    let stack = openButtons
    if (isFunctionBoundary(node) && !isInsideJsx(node)) stack = []

    if (jsxTagName(node) === 'button') {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if (stack.length > 0) {
        hits.push(`${relative}:${line} <button> in <button> (parent at :${stack[stack.length - 1]})`)
      }
      stack = [...stack, line]
    }

    ts.forEachChild(node, (child) => visit(child, stack))
  }

  visit(source, [])
  return hits
}

describe('JSX nesting', () => {
  it('no <button> is nested inside another <button> in any component', () => {
    const hits = tsxFiles(RENDERER_ROOT).flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      return collectHits(file, source)
    })

    expect(hits).toEqual([])
  })
})
