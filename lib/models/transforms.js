
import Block from './block'
import Character from './character'
import Data from './data'
import Document from './document'
import Inline from './inline'
import Mark from './mark'
import Selection from './selection'
import Text from './text'
import uid from '../utils/uid'
import { List, Map, Set } from 'immutable'

/**
 * Transforms.
 *
 * These are pulled out into their own file because they can get complex.
 */

const Transforms = {

  /**
   * Delete everything in a `range`.
   *
   * @param {Selection} range
   * @return {Node} node
   */

  deleteAtRange(range) {
    if (range.isCollapsed) return this

    let node = this

    // Make sure the children exist.
    const { startKey, startOffset, endKey, endOffset } = range
    node.assertHasDescendant(startKey)
    node.assertHasDescendant(endKey)

    // If the start and end nodes are the same, just remove characters.
    if (startKey == endKey) {
      let text = node.getDescendant(startKey)
      text = text.removeCharacters(startOffset, endOffset)
      node = node.updateDescendant(text)
      return node
    }

    // Split the blocks and determine the edge boundaries.
    const start = range.collapseToStart()
    const end = range.collapseToEnd()
    node = node.splitBlockAtRange(start, Infinity)
    node = node.splitBlockAtRange(end, Infinity)

    const startText = node.getDescendant(startKey)
    const startEdgeText = node.getNextText(startKey)

    const endText = node.getNextText(endKey)
    const endEdgeText = node.getDescendant(endKey)

    // Remove the new blocks inside the edges.
    const startEdgeBlock = node.getFurthestBlock(startEdgeText)
    const endEdgeBlock = node.getFurthestBlock(endEdgeText)

    const nodes = node.nodes
      .takeUntil(n => n == startEdgeBlock)
      .concat(node.nodes.skipUntil(n => n == endEdgeBlock).rest())

    node = node.merge({ nodes })

    // Take the end edge's split text and move it to the start edge.
    let startBlock = node.getFurthestBlock(startText)
    let endChild = node.getFurthestInline(endText) || endText

    const startNodes = startBlock.nodes.push(endChild)
    startBlock = startBlock.merge({ nodes: startNodes })
    node = node.updateDescendant(startBlock)

    // While the end child is an only child, remove the block it's in.
    let endParent = node.getClosestBlock(endChild)

    while (endParent && endParent.nodes.size == 1) {
      endChild = endParent
      endParent = node.getClosestBlock(endParent)
    }

    node = node.removeDescendant(endChild)

    // Normalize the adjacent text nodes.
    return node.normalize()
  },

  /**
   * Delete backward `n` characters at a `range`.
   *
   * @param {Selection} range
   * @param {Number} n (optional)
   * @return {Node} node
   */

  deleteBackwardAtRange(range, n = 1) {
    let node = this
    const { startKey, startOffset } = range

    // When the range is still expanded, just do a regular delete.
    if (range.isExpanded) return node.deleteAtRange(range)

    // When collapsed at the start of the node, there's nothing to do.
    if (range.isAtStartOf(node)) return node

    // When collapsed in a void node, remove that node.
    const block = node.getClosestBlock(startKey)
    if (block && block.isVoid) return node.removeDescendant(block)

    const inline = node.getClosestInline(startKey)
    if (inline && inline.isVoid) return node.removeDescendant(inline)

    // When at start of a text node, merge forwards into the next text node.
    const startNode = node.getDescendant(startKey)

    if (range.isAtStartOf(startNode)) {
      const previous = node.getPreviousText(startNode)

      // If the previous descendant is void, remove it.
      const prevBlock = node.getClosestBlock(previous)
      if (prevBlock && prevBlock.isVoid) return node.removeDescendant(prevBlock)

      const prevInline = node.getClosestInline(previous)
      if (prevInline && prevInline.isVoid) return node.removeDescendant(prevInline)

      range = range.extendToEndOf(previous)
      range = range.normalize(node)
      return node.deleteAtRange(range)
    }

    // Otherwise, remove `n` characters behind of the cursor.
    range = range.extendBackward(n)
    range = range.normalize(node)
    return node.deleteAtRange(range)
  },

  /**
   * Delete forward `n` characters at a `range`.
   *
   * @param {Selection} range
   * @param {Number} n (optional)
   * @return {Node} node
   */

  deleteForwardAtRange(range, n = 1) {
    let node = this
    const { startKey } = range

    // When the range is still expanded, just do a regular delete.
    if (range.isExpanded) return node.deleteAtRange(range)

    // When collapsed at the end of the node, there's nothing to do.
    if (range.isAtEndOf(node)) return node

    // When collapsed in a void node, remove that node.
    const block = node.getClosestBlock(startKey)
    if (block && block.isVoid) return node.removeDescendant(block)

    const inline = node.getClosestInline(startKey)
    if (inline && inline.isVoid) return node.removeDescendant(inline)

    // When at end of a text node, merge forwards into the next text node.
    const startNode = node.getDescendant(startKey)
    if (range.isAtEndOf(startNode)) {
      const next = node.getNextText(startNode)
      range = range.extendToStartOf(next)
      range = range.normalize(node)
      return node.deleteAtRange(range)
    }

    // Otherwise, remove `n` characters ahead of the cursor.
    range = range.extendForward(n)
    range = range.normalize(node)
    return node.deleteAtRange(range)
  },

  /**
   * Insert a `fragment` at a `range`.
   *
   * @param {Selection} range
   * @param {List} fragment
   * @return {Node} node
   */

  insertFragmentAtRange(range, fragment) {
    range = range.normalize(this)
    let node = this

    // If the range is expanded, delete first.
    if (range.isExpanded) {
      node = node.deleteAtRange(range)
      range = range.collapseToStart()
    }

    // If the fragment is empty, do nothing.
    if (!fragment.length) return node

    // Make sure each node in the fragment has a unique key.
    fragment = fragment.mapDescendants(child => child.set('key', uid()))

    // Split the inlines if need be.
    if (!node.isInlineSplitAtRange(range)) {
      node = node.splitInlineAtRange(range)
    }

    // Determine the start and next children to insert into.
    const { startKey, endKey } = range
    let block = node.getClosestBlock(startKey)
    let start = node.getDescendant(startKey)
    let startChild
    let nextChild

    if (range.isAtStartOf(node)) {
      nextChild = node.getClosestBlock(node.getTextNodes().first())
    }

    if (range.isAtStartOf(block)) {
      nextChild = block.getHighestChild(block.getTextNodes().first())
    }

    else if (range.isAtStartOf(start)) {
      startChild = block.getHighestChild(block.getPreviousText(start))
      nextChild = block.getNextSibling(startChild)
    }

    else {
      startChild = block.getHighestChild(start)
      nextChild = block.getNextSibling(startChild)
    }

    // Get the first and last block of the fragment.
    const blocks = fragment.getDeepestBlocks()
    const firstBlock = blocks.first()
    let lastBlock = blocks.last()

    // If the block is empty, merge in the first block's type and data.
    if (block.length == 0) {
      block = block.merge({
        type: firstBlock.type,
        data: firstBlock.data
      })
    }

    // Insert the first blocks nodes into the starting block.
    if (startChild) {
      block = block.insertChildrenAfter(startChild, firstBlock.nodes)
    } else {
      block = block.insertChildrenBefore(nextChild, firstBlock.nodes)
    }

    node = node.updateDescendant(block)

    // If there are no other siblings, that's it.
    if (firstBlock == lastBlock) return node.normalize()

    // Otherwise, remove the fragment's first block's highest solo parent...
    let highestParent = fragment.getHighestOnlyChildParent(firstBlock)
    fragment = fragment.removeDescendant(highestParent || firstBlock)

    // Then, add the inlines after the cursor from the current block to the
    // start of the last block in the fragment.
    if (nextChild) {
      lastBlock = lastBlock.concatChildren(block.getChildrenAfterIncluding(nextChild))
      fragment = fragment.updateDescendant(lastBlock)

      block = block.removeChildrenAfterIncluding(nextChild)
      node = node.updateDescendant(block)
    }


    // Finally, add the fragment's children after the block.
    node = node.insertChildrenAfter(block, fragment.nodes)
    return node.normalize()
  },

  /**
   * Insert text `string` at a `range`, with optional `marks`.
   *
   * @param {Selection} range
   * @param {String} string
   * @param {Set} marks (optional)
   * @return {Node} node
   */

  insertTextAtRange(range, string, marks) {
    let node = this

    // When still expanded, remove the current range first.
    if (range.isExpanded) {
      node = node.deleteAtRange(range)
      range = range.collapseToStart()
    }

    // Insert text at the range's offset.
    const { startKey, startOffset } = range
    let text = node.getDescendant(startKey)
    text = text.insertText(startOffset, string, marks)
    node = node.updateDescendant(text)

    return node
  },

  /**
   * Add a new `mark` to the characters at `range`.
   *
   * @param {Selection} range
   * @param {Mark or String} mark
   * @return {Node} node
   */

  markAtRange(range, mark) {
    let node = this

    // Allow for just passing a type for convenience.
    if (typeof mark == 'string') {
      mark = new Mark({ type: mark })
    }

    // When the range is collapsed, do nothing.
    if (range.isCollapsed) return node

    // Otherwise, find each of the text nodes within the range.
    const { startKey, startOffset, endKey, endOffset } = range
    let texts = node.getTextsAtRange(range)

    // Apply the mark to each of the text nodes's matching characters.
    texts = texts.map((text) => {
      let characters = text.characters.map((char, i) => {
        if (!isInRange(i, text, range)) return char
        let { marks } = char
        marks = marks.add(mark)
        return char.merge({ marks })
      })

      return text.merge({ characters })
    })

    // Update each of the text nodes.
    texts.forEach((text) => {
      node = node.updateDescendant(text)
    })

    return node
  },

  /**
   * Set the `properties` of block nodes in a `range`.
   *
   * @param {Selection} range
   * @param {Object or String} properties
   * @return {Node} node
   */

  setBlockAtRange(range, properties = {}) {
    let node = this

    // Allow for properties to be a string `type` for convenience.
    if (typeof properties == 'string') {
      properties = { type: properties }
    }

    // Update each of the blocks.
    const blocks = node.getBlocksAtRange(range)
    blocks.forEach((block) => {
      if (properties.data) properties.data = Data.create(properties.data)
      block = block.merge(properties)
      node = node.updateDescendant(block)
    })

    return node.normalize()
  },

  /**
   * Set the `properties` of inline nodes in a `range`.
   *
   * @param {Selection} range
   * @param {Object or String} properties
   * @return {Node} node
   */

  setInlineAtRange(range, properties = {}) {
    let node = this

    // Allow for properties to be a string `type` for convenience.
    if (typeof properties == 'string') {
      properties = { type: properties }
    }

    // Update each of the inlines.
    const inlines = node.getInlinesAtRange(range)
    inlines.forEach((inline) => {
      if (properties.data) properties.data = Data.create(properties.data)
      inline = inline.merge(properties)
      node = node.updateDescendant(inline)
    })

    return node.normalize()
  },

  /**
   * Split the block nodes at a `range`, to optional `depth`.
   *
   * @param {Selection} range
   * @param {Number} depth (optional)
   * @return {Node} node
   */

  splitBlockAtRange(range, depth = 1) {
    let node = this

    // If the range is expanded, remove it first.
    if (range.isExpanded) {
      node = node.deleteAtRange(range)
      range = range.collapseToStart()
    }

    // Split the inline nodes at the range.
    node = node.splitInlineAtRange(range)

    // Find the highest inline elements that were split.
    const { startKey } = range
    const firstText = node.getDescendant(startKey)
    const secondText = node.getNextText(startKey)
    let firstChild = node.getFurthestInline(firstText) || firstText
    let secondChild = node.getFurthestInline(secondText) || secondText
    let parent = node.getClosestBlock(firstChild)
    let firstChildren = parent.nodes.takeUntil(n => n == firstChild).push(firstChild)
    let secondChildren = parent.nodes.skipUntil(n => n == secondChild)
    let d = 0

    // While the parent is a block, split the block nodes.
    while (parent && d < depth) {
      firstChild = parent.merge({ nodes: firstChildren })
      secondChild = Block.create({
        nodes: secondChildren,
        type: parent.type,
        data: parent.data
      })

      firstChildren = Block.createList([firstChild])
      secondChildren = Block.createList([secondChild])

      // Add the new children.
      const grandparent = node.getParent(parent)
      const nodes = grandparent.nodes
        .takeUntil(n => n.key == firstChild.key)
        .push(firstChild)
        .push(secondChild)
        .concat(grandparent.nodes.skipUntil(n => n.key == firstChild.key).rest())

      // Update the grandparent.
      node = grandparent == node
        ? node.merge({ nodes })
        : node.updateDescendant(grandparent.merge({ nodes }))

      d++
      parent = node.getClosestBlock(firstChild)
    }

    return node
  },

  /**
   * Split the inline nodes at a `range`, to optional `depth`.
   *
   * @param {Selection} range
   * @param {Number} depth (optiona)
   * @return {Node} node
   */

  splitInlineAtRange(range, depth = Infinity) {
    let node = this

    // If the range is expanded, remove it first.
    if (range.isExpanded) {
      node = node.deleteAtRange(range)
      range = range.collapseToStart()
    }

    // First split the text nodes.
    node = node.splitTextAtRange(range)

    // Find the children that were split.
    const { startKey } = range
    let firstChild = node.getDescendant(startKey)
    let secondChild = node.getNextText(firstChild)
    let parent = node.getClosestInline(firstChild)
    let d = 0

    // While the parent is an inline parent, split the inline nodes.
    while (parent && d < depth) {
      firstChild = parent.merge({ nodes: Inline.createList([firstChild]) })
      secondChild = Inline.create({
        nodes: [secondChild],
        type: parent.type,
        data: parent.data
      })

      // Split the children.
      const grandparent = node.getParent(parent)
      const nodes = grandparent.nodes
        .takeUntil(n => n.key == firstChild.key)
        .push(firstChild)
        .push(secondChild)
        .concat(grandparent.nodes.skipUntil(n => n.key == firstChild.key).rest())

      // Update the grandparent.
      node = grandparent == node
        ? node.merge({ nodes })
        : node.updateDescendant(grandparent.merge({ nodes }))

      d++
      parent = node.getClosestInline(firstChild)
    }

    return node
  },

  /**
   * Split the text nodes at a `range`.
   *
   * @param {Selection} range
   * @return {Node} node
   */

  splitTextAtRange(range) {
    let node = this

    // If the range is expanded, remove it first.
    if (range.isExpanded) {
      node = node.deleteAtRange(range)
      range = range.collapseToStart()
    }

    // Split the text node's characters.
    const { startKey, startOffset } = range
    const text = node.getDescendant(startKey)
    const { characters } = text
    const firstChars = characters.take(startOffset)
    const secondChars = characters.skip(startOffset)
    let firstChild = text.merge({ characters: firstChars })
    let secondChild = Text.create({ characters: secondChars })

    // Split the text nodes.
    let parent = node.getParent(text)
    const nodes = parent.nodes
      .takeUntil(c => c.key == firstChild.key)
      .push(firstChild)
      .push(secondChild)
      .concat(parent.nodes.skipUntil(n => n.key == firstChild.key).rest())

    // Update the nodes.
    parent = parent.merge({ nodes })
    node = node.updateDescendant(parent)
    return node
  },

  /**
   * Remove an existing `mark` to the characters at `range`.
   *
   * @param {Selection} range
   * @param {Mark or String} mark (optional)
   * @return {Node} node
   */

  unmarkAtRange(range, mark) {
    let node = this

    // Allow for just passing a type for convenience.
    if (typeof mark == 'string') {
      mark = new Mark({ type: mark })
    }

    // When the range is collapsed, do nothing.
    if (range.isCollapsed) return node

    // Otherwise, find each of the text nodes within the range.
    let texts = node.getTextsAtRange(range)

    // Apply the mark to each of the text nodes's matching characters.
    texts = texts.map((text) => {
      let characters = text.characters.map((char, i) => {
        if (!isInRange(i, text, range)) return char
        let { marks } = char
        marks = mark
          ? marks.remove(mark)
          : marks.clear()
        return char.merge({ marks })
      })

      return text.merge({ characters })
    })

    // Update each of the text nodes.
    texts.forEach((text) => {
      node = node.updateDescendant(text)
    })

    return node
  },

  /**
   * Unwrap all of the block nodes in a `range` from a block node of `type.`
   *
   * @param {Selection} range
   * @param {String} type (optional)
   * @param {Data or Object} data (optional)
   * @return {Node} node
   */

  unwrapBlockAtRange(range, type, data) {
    let node = this

    // Allow for only data.
    if (typeof type == 'object') {
      data = type
      type = null
    }

    // Ensure that data is immutable.
    if (data) data = Data.create(data)

    // Find the closest wrapping blocks of each text node.
    const texts = node.getBlocksAtRange(range)
    const wrappers = texts.reduce((memo, text) => {
      const match = node.getClosest(text, (parent) => {
        if (parent.kind != 'block') return false
        if (type && parent.type != type) return false
        if (data && !parent.data.isSuperset(data)) return false
        return true
      })

      if (match) memo = memo.add(match)
      return memo
    }, new Set())

    // Replace each of the wrappers with their child nodes.
    wrappers.forEach((wrapper) => {
      const parent = node.getParent(wrapper)

      // Replace the wrapper in the parent's nodes with the block.
      const nodes = parent.nodes.takeUntil(n => n == wrapper)
        .concat(wrapper.nodes)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())

      // Update the parent.
      node = parent == node
        ? node.merge({ nodes })
        : node.updateDescendant(parent.merge({ nodes }))
    })

    return node.normalize()
  },

  /**
   * Unwrap the inline nodes in a `range` from an parent inline with `type`.
   *
   * @param {Selection} range
   * @param {String} type (optional)
   * @param {Data} data (optional)
   * @return {Node} node
   */

  unwrapInlineAtRange(range, type, data) {
    let node = this
    let blocks = node.getInlinesAtRange(range)

    // Allow for no type.
    if (typeof type == 'object') {
      data = type
      type = null
    }

    // Ensure that data is immutable.
    if (data) data = Data.create(data)

    // Find the closest matching inline wrappers of each text node.
    const texts = this.getTextNodes()
    const wrappers = texts.reduce((memo, text) => {
      const match = node.getClosest(text, (parent) => {
        if (parent.kind != 'inline') return false
        if (type && parent.type != type) return false
        if (data && !parent.data.isSuperset(data)) return false
        return true
      })

      if (match) memo = memo.add(match)
      return memo
    }, new Set())

    // Replace each of the wrappers with their child nodes.
    wrappers.forEach((wrapper) => {
      const parent = node.getParent(wrapper)

      // Replace the wrapper in the parent's nodes with the block.
      const nodes = parent.nodes.takeUntil(n => n == wrapper)
        .concat(wrapper.nodes)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())

      // Update the parent.
      node = parent == node
        ? node.merge({ nodes })
        : node.updateDescendant(parent.merge({ nodes }))
    })

    return node.normalize()
  },

  /**
   * Wrap all of the blocks in a `range` in a new block node of `type`.
   *
   * @param {Selection} range
   * @param {String} type
   * @param {Data} data (optional)
   * @return {Node} node
   */

  wrapBlockAtRange(range, type, data) {
    data = Data.create(data)
    let node = this

    // Get the block nodes, sorted by depth.
    const blocks = node.getBlocksAtRange(range)
    const sorted = blocks.sort((a, b) => {
      const da = node.getDepth(a)
      const db = node.getDepth(b)
      if (da == db) return 0
      else if (da > db) return -1
      else return 1
    })

    // Get the lowest common siblings, relative to the highest block.
    const highest = sorted.first()
    const depth = node.getDepth(highest)
    const siblings = blocks.reduce((memo, block) => {
      const sibling = node.getDepth(block) == depth
        ? block
        : node.getClosest(block, (p) => node.getDepth(p) == depth)
      memo = memo.push(sibling)
      return memo
    }, Block.createList())

    // Wrap the siblings in a new block.
    const wrapper = Block.create({
      nodes: siblings,
      type,
      data
    })

    // Replace the siblings with the wrapper.
    const first = siblings.first()
    const last = siblings.last()
    const parent = node.getParent(highest)
    const nodes = parent.nodes
      .takeUntil(n => n == first)
      .push(wrapper)
      .concat(parent.nodes.skipUntil(n => n == last).rest())

    // Update the parent.
    node = parent == node
      ? node.merge({ nodes })
      : node.updateDescendant(parent.merge({ nodes }))

    return node
  },

  /**
   * Wrap the text and inline nodes in a `range` with a new inline node.
   *
   * @param {Selection} range
   * @param {String} type
   * @param {Data} data (optional)
   * @return {Node} node
   */

  wrapInlineAtRange(range, type, data) {
    data = Data.create(data)
    let node = this

    // If collapsed or unset, there's nothing to wrap.
    if (range.isCollapsed || range.isUnset) return node

    // Split at the start of the range.
    const start = range.collapseToStart()
    node = node.splitInlineAtRange(start)

    // Determine the new end of the range, and split there.
    const { startKey, startOffset, endKey, endOffset } = range
    const firstNode = node.getDescendant(startKey)
    const nextNode = node.getNextText(startKey)
    const end = startKey != endKey
      ? range.collapseToEnd()
      : Selection.create({
          anchorKey: nextNode.key,
          anchorOffset: endOffset - startOffset,
          focusKey: nextNode.key,
          focusOffset: endOffset - startOffset
        })

    node = node.splitInlineAtRange(end)

    // Calculate the new range to wrap around.
    const endNode = node.getDescendant(end.anchorKey)
    range = Selection.create({
      anchorKey: nextNode.key,
      anchorOffset: 0,
      focusKey: endNode.key,
      focusOffset: endNode.length
    })

    // Get the furthest inline nodes in the range.
    const texts = node.getTextsAtRange(range)
    const children = texts.map(text => node.getFurthestInline(text) || text)

    // Iterate each of the child nodes, wrapping them.
    children.forEach((child) => {
      const obj = {}
      obj.nodes = [child]
      obj.type = type
      if (data) obj.data = data
      const wrapper = Inline.create(obj)

      // Replace the child in it's parent with the wrapper.
      const parent = node.getParent(child)
      const nodes = parent.nodes.takeUntil(n => n == child)
        .push(wrapper)
        .concat(parent.nodes.skipUntil(n => n == child).rest())

      // Update the parent.
      node = parent == node
        ? node.merge({ nodes })
        : node.updateDescendant(parent.merge({ nodes }))
    })

    return node
  }

}

/**
 * Check if an `index` of a `text` node is in a `range`.
 *
 * @param {Number} index
 * @param {Text} text
 * @param {Selection} range
 * @return {Set} characters
 */

function isInRange(index, text, range) {
  const { startKey, startOffset, endKey, endOffset } = range
  let matcher

  if (text.key == startKey && text.key == endKey) {
    return startOffset <= index && index < endOffset
  } else if (text.key == startKey) {
    return startOffset <= index
  } else if (text.key == endKey) {
    return index < endOffset
  } else {
    return true
  }
}

/**
 * Export.
 */

export default Transforms
