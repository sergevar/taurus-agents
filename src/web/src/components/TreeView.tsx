import { useState, useCallback, useMemo, type ReactNode, type CSSProperties } from 'react';

// ── Types ──

export interface TreeItem {
  id: string;
  parentId: string | null;
}

export interface TreeViewProps<T extends TreeItem> {
  items: T[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  renderIcon?: (item: T, depth: number) => ReactNode;
  renderLabel: (item: T, depth: number) => ReactNode;
  renderSecondary?: (item: T, depth: number) => ReactNode;
  renderActions?: (item: T, depth: number) => ReactNode;
  defaultExpanded?: boolean;
  emptyMessage?: string;
  className?: string;
}

// ── Internal tree building ──

interface TreeNode<T> {
  item: T;
  children: TreeNode<T>[];
}

function buildTree<T extends TreeItem>(items: T[]): TreeNode<T>[] {
  const byId = new Map<string, TreeNode<T>>();
  const roots: TreeNode<T>[] = [];

  for (const item of items) {
    byId.set(item.id, { item, children: [] });
  }

  for (const item of items) {
    const node = byId.get(item.id)!;
    if (item.parentId && byId.has(item.parentId)) {
      byId.get(item.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ── Layout constants ──

const BASE_PAD = 8;
const INDENT = 20;
const TOGGLE_HALF = 4; // floor(9px toggle / 2)

// ── Component ──

export function TreeView<T extends TreeItem>({
  items,
  selectedId,
  onSelect,
  renderIcon,
  renderLabel,
  renderSecondary,
  renderActions,
  defaultExpanded = true,
  emptyMessage = 'Nothing here',
  className,
}: TreeViewProps<T>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setExpanded(prev => ({ ...prev, [id]: !(prev[id] ?? defaultExpanded) }));
  }, [defaultExpanded]);

  const tree = useMemo(() => buildTree(items), [items]);

  const isExpanded = useCallback(
    (id: string) => expanded[id] ?? defaultExpanded,
    [expanded, defaultExpanded],
  );

  if (items.length === 0) {
    return (
      <div className={`tv ${className ?? ''}`}>
        <div className="tv__empty">{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className={`tv ${className ?? ''}`}>
      {tree.map(node => (
        <TreeNodeView
          key={node.item.id}
          node={node}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          toggle={toggle}
          isExpanded={isExpanded}
          renderIcon={renderIcon}
          renderLabel={renderLabel}
          renderSecondary={renderSecondary}
          renderActions={renderActions}
        />
      ))}
    </div>
  );
}

// ── Recursive node renderer ──

interface TreeNodeViewProps<T extends TreeItem> {
  node: TreeNode<T>;
  depth: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  toggle: (e: React.MouseEvent, id: string) => void;
  isExpanded: (id: string) => boolean;
  renderIcon?: (item: T, depth: number) => ReactNode;
  renderLabel: (item: T, depth: number) => ReactNode;
  renderSecondary?: (item: T, depth: number) => ReactNode;
  renderActions?: (item: T, depth: number) => ReactNode;
}

function TreeNodeView<T extends TreeItem>({
  node,
  depth,
  selectedId,
  onSelect,
  toggle,
  isExpanded,
  renderIcon,
  renderLabel,
  renderSecondary,
  renderActions,
}: TreeNodeViewProps<T>) {
  const { item, children } = node;
  const hasChildren = children.length > 0;
  const open = hasChildren ? isExpanded(item.id) : false;
  const selected = item.id === selectedId;

  const rowPadLeft = BASE_PAD + depth * INDENT;

  // Connector line x = center of the parent's toggle box
  const lineX = depth > 0
    ? BASE_PAD + (depth - 1) * INDENT + TOGGLE_HALF
    : 0;

  const groupStyle: CSSProperties = depth > 0
    ? { '--line-x': `${lineX}px` } as CSSProperties
    : {};

  const secondaryContent = renderSecondary?.(item, depth);

  return (
    <div
      className={`tv__group${depth > 0 ? ' tv__group--child' : ''}${depth > 0 && !hasChildren ? ' tv__group--leaf' : ''}`}
      data-depth={depth}
      style={groupStyle}
    >
      {/* Node row */}
      <div
        className={`tv__node${selected ? ' tv__node--selected' : ''}`}
        onClick={() => onSelect?.(item.id)}
      >
        <div className="tv__row" style={{ paddingLeft: rowPadLeft }}>
          {hasChildren ? (
            <button
              className={`tv__toggle${open ? ' tv__toggle--open' : ''}`}
              onClick={(e) => toggle(e, item.id)}
            />
          ) : (
            <span className="tv__leaf" />
          )}

          <span className="tv__icon">{renderIcon?.(item, depth)}</span>

          <div className="tv__label">{renderLabel(item, depth)}</div>

          {renderActions && (
            <div className="tv__actions" onClick={e => e.stopPropagation()}>
              {renderActions(item, depth)}
            </div>
          )}

          {secondaryContent && (
            <div className="tv__secondary">{secondaryContent}</div>
          )}
        </div>

        {/* Stem: vertical dotted line from toggle center to bottom of node */}
        {hasChildren && open && (
          <span
            className="tv__stem"
            style={{ left: rowPadLeft + TOGGLE_HALF }}
          />
        )}
      </div>

      {/* Children */}
      {hasChildren && open && (
        <div className="tv__children">
          {children.map(child => (
            <TreeNodeView
              key={child.item.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              toggle={toggle}
              isExpanded={isExpanded}
              renderIcon={renderIcon}
              renderLabel={renderLabel}
              renderSecondary={renderSecondary}
              renderActions={renderActions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
