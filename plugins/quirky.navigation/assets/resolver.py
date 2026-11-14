"""Resolve Python definitions and references without importing or running worktree code."""

import ast
import io
import json
import os
import re
import stat
import sys
import tokenize
from collections import OrderedDict
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname

MAX_FILE_BYTES = 2 * 1024 * 1024
CACHE_SIZE = 256


def _line_parts(text):
    return re.split(r"\r\n|\r|\n", text)


def _within(root, path):
    try:
        return os.path.commonpath((root, path)) == root
    except (ValueError, OSError):
        return False


def _stat_file(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return None
    return (info.st_mtime_ns, info.st_size)


def _uri_path(uri):
    if not isinstance(uri, str):
        return None
    parsed = urlsplit(uri)
    if parsed.scheme.lower() != "file":
        return None
    path = url2pathname(unquote(parsed.path))
    if parsed.netloc and parsed.netloc not in ("", "localhost"):
        path = "//" + parsed.netloc + path
    return os.path.realpath(path)


def _utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


class Location(object):
    __slots__ = ("path", "line", "column", "end_line", "end_column")

    def __init__(self, path, line, column, end_line, end_column):
        self.path = path
        self.line = line
        self.column = column
        self.end_line = end_line
        self.end_column = end_column

    def key(self):
        return (self.path, self.line, self.column, self.end_line, self.end_column)

    def lsp(self):
        return {
            "uri": Path(self.path).as_uri(),
            "range": {
                "start": {"line": self.line - 1, "character": self.column - 1},
                "end": {"line": self.end_line - 1, "character": self.end_column - 1},
            },
        }


class Symbol(object):
    __slots__ = ("name", "key", "keys", "locations", "targets", "entity")

    def __init__(self, name, key):
        self.name = name
        self.key = key
        self.keys = set((key,))
        self.locations = []
        self.targets = []
        self.entity = None

    def add_location(self, location):
        _append_location(self.locations, location)

    def add_target(self, location):
        _append_location(self.targets, location)

    def definition_locations(self):
        return self.targets if self.targets else self.locations


class Binding(Symbol):
    __slots__ = ("scope", "imports", "imported", "alias_import")

    def __init__(self, name, key, scope):
        Symbol.__init__(self, name, key)
        self.scope = scope
        self.imports = []
        self.imported = False
        self.alias_import = False


class Scope(object):
    __slots__ = ("kind", "path", "serial", "parent", "bindings", "globals", "nonlocals", "class_info", "owner_class")

    def __init__(self, kind, path, serial, parent=None, class_info=None, owner_class=None):
        self.kind = kind
        self.path = path
        self.serial = serial
        self.parent = parent
        self.bindings = {}
        self.globals = set()
        self.nonlocals = set()
        self.class_info = class_info
        self.owner_class = owner_class

    def binding(self, name):
        value = self.bindings.get(name)
        if value is None:
            key = "local\0{}\0{}\0{}".format(self.path, self.serial, name)
            value = Binding(name, key, self)
            self.bindings[name] = value
        return value


class ClassInfo(object):
    __slots__ = ("name", "binding", "scope", "bases", "attributes", "node", "parent_scope")

    def __init__(self, name, binding, node, parent_scope):
        self.name = name
        self.binding = binding
        self.scope = None
        self.bases = []
        self.attributes = {}
        self.node = node
        self.parent_scope = parent_scope


class FunctionInfo(object):
    __slots__ = ("name", "binding", "scope", "node", "owner_class", "return_entity")

    def __init__(self, name, binding, node, owner_class):
        self.name = name
        self.binding = binding
        self.scope = None
        self.node = node
        self.owner_class = owner_class
        self.return_entity = None


class Occurrence(object):
    __slots__ = ("name", "location", "symbol", "keys", "targets", "entity")

    def __init__(self, name, location, symbol=None, keys=None, targets=None, entity=None):
        self.name = name
        self.location = location
        self.symbol = symbol
        self.keys = set(keys or ())
        self.targets = list(targets or ())
        self.entity = entity

    def ref_keys(self):
        return self.symbol.keys if self.symbol is not None else self.keys

    def definition_locations(self):
        if self.symbol is not None:
            return self.symbol.definition_locations()
        return self.targets


class ImportSpec(object):
    __slots__ = ("kind", "binding", "local_name", "module", "level", "module_names", "name", "name_location", "alias_location", "renamed", "module_token_prefixes", "fallback", "module_prefix_count", "source_symbol")

    def __init__(self, kind, binding, local_name, module, level, module_names, name=None,
                 name_location=None, alias_location=None, renamed=False, module_token_prefixes=None):
        self.kind = kind
        self.binding = binding
        self.local_name = local_name
        self.module = module
        self.level = level
        self.module_names = module_names
        self.name = name
        self.name_location = name_location
        self.alias_location = alias_location
        self.renamed = renamed
        self.module_token_prefixes = module_token_prefixes or []
        self.fallback = None
        self.module_prefix_count = 0
        self.source_symbol = None


class FileModel(object):
    __slots__ = ("path", "signature", "lines", "root_scope", "scopes", "classes", "functions", "imports", "occurrences", "by_name", "names", "state", "root", "_occurrence_keys", "_node_scope", "_tree", "_source", "_scope_builder", "_dependency_stamps")

    def __init__(self, path, signature, lines=None):
        self.path = path
        self.signature = signature
        self.lines = lines or []
        self.root_scope = None
        self.scopes = []
        self.classes = []
        self.functions = []
        self.imports = []
        self.occurrences = []
        self.by_name = {}
        self.names = set()
        self.state = "new"
        self.root = None
        self._occurrence_keys = set()
        self._node_scope = {}
        self._tree = None
        self._source = None
        self._scope_builder = None
        self._dependency_stamps = {}

    def add_occurrence(self, occurrence):
        if occurrence is None:
            return
        key = (occurrence.name, occurrence.location.key(), id(occurrence.symbol),
               tuple(sorted(occurrence.keys)))
        existing = getattr(self, "_occurrence_keys", None)
        if existing is None:
            self._occurrence_keys = set()
            existing = self._occurrence_keys
        if key in existing:
            return
        existing.add(key)
        self.occurrences.append(occurrence)
        self.by_name.setdefault(occurrence.name, []).append(occurrence)
        self.names.add(occurrence.name)


def _append_location(collection, location):
    key = location.key()
    for existing in collection:
        if existing.key() == key:
            return
    collection.append(location)


def _entity(kind, **fields):
    value = {"kind": kind}
    value.update(fields)
    return value


def _entity_as_value(entity):
    if entity is None:
        return None
    if entity.get("kind") == "class":
        return _entity("instance", info=entity["info"])
    return entity


class BindingCollector(ast.NodeVisitor):
    def __init__(self, scope):
        self.scope = scope

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.scope.binding(node.id)

    def visit_FunctionDef(self, node):
        self.scope.binding(node.name)

    def visit_AsyncFunctionDef(self, node):
        self.scope.binding(node.name)

    def visit_ClassDef(self, node):
        self.scope.binding(node.name)

    def visit_Lambda(self, node):
        return

    def visit_Import(self, node):
        for alias in node.names:
            name = alias.asname or alias.name.split(".", 1)[0]
            if name != "*":
                self.scope.binding(name)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            name = alias.asname or alias.name
            if name != "*":
                self.scope.binding(name)

    def visit_Global(self, node):
        self.scope.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.scope.nonlocals.update(node.names)

    def visit_ListComp(self, node):
        self._visit_comprehension_outer(node.generators, (node.elt,))

    def visit_SetComp(self, node):
        self._visit_comprehension_outer(node.generators, (node.elt,))

    def visit_GeneratorExp(self, node):
        self._visit_comprehension_outer(node.generators, (node.elt,))

    def visit_DictComp(self, node):
        self._visit_comprehension_outer(node.generators, (node.key, node.value))

    def _visit_comprehension_outer(self, generators, tail):
        for index, generator in enumerate(generators):
            self.visit(generator.iter)
            if index:
                for condition in generator.ifs:
                    self.visit(condition)
        for expression in tail:
            self.visit(expression)

    def visit_ExceptHandler(self, node):
        if node.type is not None:
            self.visit(node.type)
        if node.name:
            self.scope.binding(node.name)
        for statement in node.body:
            self.visit(statement)


class ScopeBuilder(object):
    def __init__(self, model):
        self.model = model
        self.serial = 0
        self.node_scopes = {}

    def _new_scope(self, node, parent, kind, body, args=None, class_info=None, owner_class=None, comp_targets=None):
        self.serial += 1
        scope = Scope(kind, self.model.path, self.serial, parent, class_info, owner_class)
        self.model.scopes.append(scope)
        self.node_scopes[id(node)] = scope
        collector = BindingCollector(scope)
        for statement in body:
            collector.visit(statement)
        if comp_targets:
            for target in comp_targets:
                for name in _target_names(target):
                    scope.binding(name)
        if args is not None:
            for argument in _arguments(args):
                scope.binding(argument.arg)
        for name in scope.globals | scope.nonlocals:
            scope.bindings.pop(name, None)
        return scope

    def build(self, tree):
        scope = self._new_scope(tree, None, "module", tree.body)
        self.model.root_scope = scope
        self._map_block(tree.body, scope)
        return scope

    def _map_node(self, node, scope):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.model._node_scope[id(node)] = scope
            for expression in node.decorator_list:
                self._map_node(expression, scope)
            for expression in node.args.defaults + [item for item in node.args.kw_defaults if item is not None]:
                self._map_node(expression, scope)
            for argument in _arguments(node.args):
                if argument.annotation is not None:
                    self._map_node(argument.annotation, scope)
            if node.returns is not None:
                self._map_node(node.returns, scope)
            binding = scope.binding(node.name)
            info = FunctionInfo(node.name, binding, node, scope.class_info or scope.owner_class)
            binding.entity = _entity("function", info=info)
            child_owner = scope.class_info or scope.owner_class
            child = self._new_scope(node, scope, "function", node.body, node.args, owner_class=child_owner)
            info.scope = child
            self.model.functions.append(info)
            for statement in node.body:
                self._map_node(statement, child)
            return
        if isinstance(node, ast.ClassDef):
            self.model._node_scope[id(node)] = scope
            for expression in node.decorator_list + node.bases:
                self._map_node(expression, scope)
            for keyword in node.keywords:
                self._map_node(keyword.value, scope)
            binding = scope.binding(node.name)
            info = ClassInfo(node.name, binding, node, scope)
            binding.entity = _entity("class", info=info)
            child = self._new_scope(node, scope, "class", node.body, class_info=info, owner_class=info)
            info.scope = child
            self.model.classes.append(info)
            for statement in node.body:
                self._map_node(statement, child)
            return
        if isinstance(node, ast.Lambda):
            self.model._node_scope[id(node)] = scope
            for expression in node.args.defaults + [item for item in node.args.kw_defaults if item is not None]:
                self._map_node(expression, scope)
            owner = scope.class_info or scope.owner_class
            child = self._new_scope(node, scope, "lambda", [node.body], node.args, owner_class=owner)
            self._map_node(node.body, child)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            self.model._node_scope[id(node)] = scope
            generators = node.generators
            if generators:
                self._map_node(generators[0].iter, scope)
            targets = [generator.target for generator in generators]
            owner = scope.class_info or scope.owner_class
            child = self._new_scope(node, scope, "comprehension", [], owner_class=owner, comp_targets=targets)
            for index, generator in enumerate(generators):
                if index:
                    self._map_node(generator.iter, child)
                self._map_node(generator.target, child)
                for condition in generator.ifs:
                    self._map_node(condition, child)
            if isinstance(node, ast.DictComp):
                self._map_node(node.key, child)
                self._map_node(node.value, child)
            else:
                self._map_node(node.elt, child)
            return
        self.model._node_scope[id(node)] = scope
        for child in ast.iter_child_nodes(node):
            self._map_node(child, scope)

    def _map_block(self, nodes, scope):
        for node in nodes:
            self._map_node(node, scope)


def _arguments(args):
    values = []
    values.extend(getattr(args, "posonlyargs", ()))
    values.extend(args.args)
    if args.vararg is not None:
        values.append(args.vararg)
    values.extend(args.kwonlyargs)
    if args.kwarg is not None:
        values.append(args.kwarg)
    return values


def _target_names(target):
    if isinstance(target, ast.Name):
        return (target.id,)
    if isinstance(target, (ast.Tuple, ast.List)):
        result = []
        for element in target.elts:
            result.extend(_target_names(element))
        return result
    return ()


def _byte_column_to_char(line, byte_column):
    encoded = line.encode("utf-8")
    return len(encoded[:byte_column].decode("utf-8", "ignore"))


def _location_from_chars(model, name, line, start_char, end_char):
    if line < 1 or line > len(model.lines):
        return None
    text = model.lines[line - 1]
    if start_char < 0 or end_char < start_char or end_char > len(text):
        return None
    if text[start_char:end_char] != name:
        return None
    return Location(model.path, line,
                    _utf16_length(text[:start_char]) + 1,
                    line,
                    _utf16_length(text[:end_char]) + 1)


def _ast_location(model, node, name):
    line = getattr(node, "lineno", None)
    start_byte = getattr(node, "col_offset", None)
    end_byte = getattr(node, "end_col_offset", None)
    end_line = getattr(node, "end_lineno", line)
    if line is None or start_byte is None or end_byte is None or end_line != line:
        return None
    if line < 1 or line > len(model.lines):
        return None
    source = model.lines[line - 1]
    start_char = _byte_column_to_char(source, start_byte)
    end_char = _byte_column_to_char(source, end_byte)
    return _location_from_chars(model, name, line, start_char, end_char)


def _ast_attribute_location(model, node):
    line = getattr(node, "end_lineno", None)
    end_byte = getattr(node, "end_col_offset", None)
    if line is None or end_byte is None or line < 1 or line > len(model.lines):
        return None
    source = model.lines[line - 1]
    end_char = _byte_column_to_char(source, end_byte)
    start_char = end_char - len(node.attr)
    return _location_from_chars(model, node.attr, line, start_char, end_char)


def _token_stream(model, node, end_line=None):
    start_line = getattr(node, "lineno", 1)
    start_byte = getattr(node, "col_offset", 0)
    if start_line < 1 or start_line > len(model.lines):
        return
    first_column = _byte_column_to_char(model.lines[start_line - 1], start_byte)
    last_line = end_line or getattr(node, "end_lineno", None) or len(model.lines)
    last_line = min(max(last_line, start_line), len(model.lines))
    parts = [model.lines[start_line - 1][first_column:]]
    for index in range(start_line, last_line):
        parts.append(model.lines[index])
    fragment = "\n".join(parts)
    try:
        stream = tokenize.generate_tokens(io.StringIO(fragment).readline)
        for token in stream:
            row, column = token.start
            end_row, end_column = token.end
            global_row = start_line + row - 1
            global_end_row = start_line + end_row - 1
            if row == 1:
                column += first_column
            if end_row == 1:
                end_column += first_column
            yield (token.type, token.string, global_row, column, global_end_row, end_column)
    except (tokenize.TokenError, IndentationError):
        return


def _token_location(model, name, token):
    if token is None:
        return None
    unused_type, token_text, line, column, end_line, end_column = token
    if token_text != name or line != end_line:
        return None
    return _location_from_chars(model, name, line, column, end_column)


def _meaningful_tokens(tokens):
    ignored = (tokenize.ENCODING, tokenize.ENDMARKER, tokenize.NL, tokenize.NEWLINE,
               tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT)
    return [token for token in tokens if token[0] not in ignored]


def _find_name_after(model, node, keyword, name):
    found_keyword = False
    for token in _token_stream(model, node):
        if token[0] == tokenize.NAME and token[1] == keyword:
            found_keyword = True
            continue
        if found_keyword and token[0] == tokenize.NAME and token[1] == name:
            return _token_location(model, name, token)
    return None


def _find_names_after(model, node, keyword, names):
    found_keyword = False
    remaining = list(names)
    result = []
    for token in _token_stream(model, node):
        if not found_keyword:
            if token[0] == tokenize.NAME and token[1] == keyword:
                found_keyword = True
            continue
        if token[0] == tokenize.NAME and token[1] in remaining:
            location = _token_location(model, token[1], token)
            if location is not None:
                result.append((token[1], location))
                remaining.remove(token[1])
                if not remaining:
                    break
    return result


def _find_alias_sequence(tokens, expected, start):
    significant = _meaningful_tokens(tokens)
    components = expected.split(".")
    for index in range(start, len(significant)):
        if significant[index][0] != tokenize.NAME or significant[index][1] != components[0]:
            continue
        cursor = index
        matched = [significant[cursor]]
        valid = True
        for component in components[1:]:
            cursor += 1
            if cursor >= len(significant) or significant[cursor][1] != ".":
                valid = False
                break
            cursor += 1
            if cursor >= len(significant) or significant[cursor][0] != tokenize.NAME or significant[cursor][1] != component:
                valid = False
                break
            matched.append(significant[cursor])
        if valid:
            return matched, cursor + 1
    return [], start


def _parse_import_aliases(model, node, aliases, import_token_index):
    tokens = _meaningful_tokens(list(_token_stream(model, node)))
    results = []
    cursor = import_token_index + 1
    for alias in aliases:
        matched, next_index = _find_alias_sequence(tokens, alias.name, cursor)
        alias_location = None
        if matched:
            cursor = next_index
            while cursor < len(tokens) and tokens[cursor][1] in (",", "(", ")"):
                cursor += 1
            if cursor < len(tokens) and tokens[cursor][0] == tokenize.NAME and tokens[cursor][1] == "as":
                if cursor + 1 < len(tokens) and tokens[cursor + 1][0] == tokenize.NAME:
                    alias_location = _token_location(model, alias.asname or tokens[cursor + 1][1], tokens[cursor + 1])
                    cursor += 2
            results.append((matched, alias_location))
        else:
            results.append(([], None))
    return results


def _statement_name_tokens(model, node):
    tokens = _meaningful_tokens(list(_token_stream(model, node)))
    for index, token in enumerate(tokens):
        if token[0] == tokenize.NAME and token[1] == "import":
            return tokens, index
    return tokens, -1


class Resolver(object):
    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.cache = OrderedDict()
        self._refreshing = set()
        self._resolution_stack = []
        self._resolution_group = None

    def _eligible_path(self, path):
        real = os.path.realpath(path)
        return real if _within(self.root, real) else None

    def _read_model_bytes(self, path):
        try:
            with open(path, "rb") as source:
                return source.read(MAX_FILE_BYTES + 1)
        except OSError:
            return None

    def _cached(self, path, signature):
        model = self.cache.get(path)
        if model is not None and model.signature == signature:
            self.cache.move_to_end(path)
            return model
        if model is not None:
            del self.cache[path]
        return None

    def load(self, path, needle=None):
        owner = self._resolution_stack[-1] if self._resolution_stack else None
        outermost = owner is None and self._resolution_group is None
        if outermost:
            self._resolution_group = []
        if owner is not None:
            self._record_dependency(owner, path)
        try:
            model = self._load(path, needle)
            if owner is not None and model is not None and owner is not model:
                self._record_model_dependencies(owner, model)
            if model is not None and self._resolution_group is not None:
                self._resolution_group.append(model)
            return model
        finally:
            if outermost:
                group = self._resolution_group
                try:
                    self._propagate_dependency_group(group)
                finally:
                    self._resolution_group = None

    def _load(self, path, needle=None):
        path = self._eligible_path(path)
        if path is None or not path.endswith((".py", ".pyi")):
            return None
        signature = _stat_file(path)
        if signature is None or signature[1] > MAX_FILE_BYTES:
            self.cache.pop(path, None)
            return None
        model = self._cached(path, signature)
        if (model is not None and model.state in ("resolved", "ready")
                and not self._dependencies_fresh(model)):
            self.cache.pop(path, None)
            model = None
        if model is not None:
            if needle is not None and needle not in model.names:
                return None
            if model.state == "new":
                self._build_model(model)
            if model.imports and model.state in ("resolved", "ready") and path not in self._refreshing:
                self._refresh_imports(model)
            return model
        data = self._read_model_bytes(path)
        if data is None or len(data) > MAX_FILE_BYTES:
            return None
        if needle is not None and not self._contains_identifier(data, needle):
            return None
        model = FileModel(path, signature)
        self.cache[path] = model
        self.cache.move_to_end(path)
        while len(self.cache) > CACHE_SIZE:
            self.cache.popitem(last=False)
        self._build_model(model, data)
        if needle is not None and needle not in model.names:
            return None
        return model

    def _dependencies_fresh(self, model):
        for path, signature in model._dependency_stamps.items():
            if _stat_file(path) != signature:
                return False
        return True

    def _record_dependency(self, model, path, signature=None):
        if path is None:
            return
        path = self._eligible_path(path)
        if path is None or path == model.path:
            return
        if signature is None:
            signature = _stat_file(path)
        if signature is not None:
            model._dependency_stamps[path] = signature

    def _record_model_dependencies(self, model, dependency):
        self._record_dependency(model, dependency.path, dependency.signature)
        for path, signature in dependency._dependency_stamps.items():
            self._record_dependency(model, path, signature)

    def _propagate_dependency_group(self, models):
        unique = {}
        for model in models:
            if model.state in ("resolved", "ready"):
                unique[id(model)] = model
        models = list(unique.values())
        for unused in range(len(models)):
            for model in models:
                for dependency in models:
                    if dependency is model or dependency.path not in model._dependency_stamps:
                        continue
                    self._record_model_dependencies(model, dependency)

    def _contains_identifier(self, data, name):
        try:
            encoding, unused = tokenize.detect_encoding(io.BytesIO(data).readline)
            encoded = name.encode(encoding)
        except (SyntaxError, UnicodeError, LookupError):
            encoded = name.encode("utf-8")
        return encoded in data

    def _build_model(self, model, data=None):
        if model.state != "new":
            return
        model.state = "building"
        if data is None:
            data = self._read_model_bytes(model.path)
        if data is None or len(data) > MAX_FILE_BYTES:
            model.state = "ready"
            return
        try:
            encoding, unused = tokenize.detect_encoding(io.BytesIO(data).readline)
            source = data.decode(encoding)
            lines = _line_parts(source)
            tree = ast.parse(source, filename=model.path)
        except (SyntaxError, UnicodeError, LookupError, RecursionError, tokenize.TokenError):
            model.state = "ready"
            return
        model.lines = lines
        model._node_scope = {}
        model._occurrence_keys = set()
        builder = ScopeBuilder(model)
        builder.build(tree)
        model._scope_builder = builder
        self._collect_imports(model, tree, model.root_scope)
        model._tree = tree
        model._source = source
        self._resolve_model(model)
        model.lines = []
        model._tree = None
        model._source = None
        model._node_scope = {}
        model._scope_builder = None
        model.state = "ready"

    def _collect_imports(self, model, node, scope):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._collect_imports(model, node.args, scope)
            for expression in node.decorator_list:
                self._collect_imports(model, expression, scope)
            for expression in node.args.defaults + [item for item in node.args.kw_defaults if item is not None]:
                self._collect_imports(model, expression, scope)
            child_scope = model._node_scope[id(node)]
            for statement in node.body:
                self._collect_imports(model, statement, child_scope)
            return
        if isinstance(node, ast.ClassDef):
            for expression in node.decorator_list + node.bases:
                self._collect_imports(model, expression, scope)
            child_scope = model._node_scope[id(node)]
            for statement in node.body:
                self._collect_imports(model, statement, child_scope)
            return
        if isinstance(node, ast.Lambda):
            self._collect_imports(model, node.args, scope)
            self._collect_imports(model, node.body, model._node_scope[id(node)])
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            if node.generators:
                self._collect_imports(model, node.generators[0].iter, scope)
            child_scope = model._node_scope[id(node)]
            for generator in node.generators:
                self._collect_imports(model, generator.iter, child_scope)
                for condition in generator.ifs:
                    self._collect_imports(model, condition, child_scope)
            for child in ast.iter_child_nodes(node):
                if not isinstance(child, ast.comprehension):
                    self._collect_imports(model, child, child_scope)
            return
        if isinstance(node, ast.Import):
            self._index_import(model, node, scope)
            return
        if isinstance(node, ast.ImportFrom):
            self._index_import_from(model, node, scope)
            return
        for child in ast.iter_child_nodes(node):
            self._collect_imports(model, child, scope)

    def _index_import(self, model, node, scope):
        tokens, keyword_index = _statement_name_tokens(model, node)
        if keyword_index < 0:
            return
        parsed = _parse_import_aliases(model, node, node.names, keyword_index)
        for alias, (name_tokens, alias_location) in zip(node.names, parsed):
            parts = alias.name.split(".")
            module_names = []
            for index, component in enumerate(parts):
                token = name_tokens[index] if index < len(name_tokens) else None
                location = _token_location(model, component, token) if token is not None else None
                module_names.append((component, location, parts[:index + 1]))
            local_name = alias.asname or parts[0]
            binding = scope.binding(local_name)
            spec = ImportSpec("import", binding, local_name, alias.name, 0, module_names,
                              alias_location=alias_location, renamed=alias.asname is not None)
            binding.imports.append(spec)
            model.imports.append(spec)

    def _index_import_from(self, model, node, scope):
        tokens, keyword_index = _statement_name_tokens(model, node)
        if keyword_index < 0:
            return
        from_index = -1
        for index, token in enumerate(tokens[:keyword_index]):
            if token[0] == tokenize.NAME and token[1] == "from":
                from_index = index
                break
        raw_module_tokens = []
        if from_index >= 0:
            for token in tokens[from_index + 1:keyword_index]:
                if token[0] == tokenize.NAME:
                    raw_module_tokens.append(token)
        parsed = _parse_import_aliases(model, node, node.names, keyword_index)
        module = node.module or ""
        module_parts = module.split(".") if module else []
        relative_prefix_count = len(module_parts)
        for alias, (name_tokens, alias_location) in zip(node.names, parsed):
            if alias.name == "*":
                continue
            name_token = name_tokens[0] if name_tokens else None
            name_location = _token_location(model, alias.name, name_token) if name_token is not None else None
            local_name = alias.asname or alias.name
            binding = scope.binding(local_name)
            module_names = []
            for index, token in enumerate(raw_module_tokens):
                module_names.append((token[1], _token_location(model, token[1], token), None))
            spec = ImportSpec("from", binding, local_name, module, node.level, module_names,
                              name=alias.name, name_location=name_location,
                              alias_location=alias_location, renamed=alias.asname is not None)
            spec.module_prefix_count = relative_prefix_count
            binding.imports.append(spec)
            model.imports.append(spec)

    def _resolve_model(self, model):
        if model.state == "resolving" or model.state == "resolved":
            return
        model.state = "resolving"
        model._dependency_stamps = {}
        self._resolution_stack.append(model)
        try:
            for spec in model.imports:
                self._resolve_import(model, spec)
            self._prepare_entities(model, model._tree)
            analyzer = Analyzer(self, model)
            analyzer.walk(model._tree, model.root_scope, declare=True, record=False)
            analyzer.walk(model._tree, model.root_scope, declare=False, record=True)
            for info in model.classes:
                info.node = None
            for function in model.functions:
                function.node = None
            model.state = "resolved"
        finally:
            self._resolution_stack.pop()

    def _refresh_imports(self, model):
        self._refreshing.add(model.path)
        self._resolution_stack.append(model)
        try:
            seen = set()
            for spec in model.imports:
                binding = spec.binding
                identity = id(binding)
                if identity in seen:
                    continue
                seen.add(identity)
                binding.keys = set((binding.key,))
                binding.targets[:] = []
                binding.entity = None
                binding.imported = False
                binding.alias_import = False
            for spec in model.imports:
                self._resolve_import(model, spec)
        finally:
            self._resolution_stack.pop()
            self._refreshing.discard(model.path)

    def _import_roots(self, path):
        directory = os.path.dirname(path)
        while os.path.isfile(os.path.join(directory, "__init__.py")) or os.path.isfile(os.path.join(directory, "__init__.pyi")):
            parent = os.path.dirname(directory)
            if parent == directory:
                break
            directory = parent
        candidates = (directory, self.root, os.path.join(self.root, "src"))
        result = []
        for candidate in candidates:
            candidate = os.path.realpath(candidate)
            if _within(self.root, candidate) and candidate not in result:
                result.append(candidate)
        return result

    def _path_module_parts(self, path, root):
        try:
            relative = os.path.relpath(path, root)
        except ValueError:
            return None
        if relative == os.pardir or relative.startswith(os.pardir + os.sep):
            return None
        parts = relative.split(os.sep)
        if not parts[-1].endswith((".py", ".pyi")):
            return None
        parts[-1] = parts[-1].rsplit(".", 1)[0]
        if parts[-1] == "__init__":
            parts.pop()
        return parts

    def _resolve_parts(self, root, parts):
        if not parts:
            return None
        current = root
        for index, part in enumerate(parts):
            if not part or part in (".", ".."):
                return None
            directory = os.path.join(current, part)
            if os.path.islink(directory):
                return None
            init_py = os.path.join(directory, "__init__.py")
            init_pyi = os.path.join(directory, "__init__.pyi")
            module_py = os.path.join(current, part + ".py")
            module_pyi = os.path.join(current, part + ".pyi")
            is_last = index == len(parts) - 1
            if os.path.isdir(directory) and os.path.isfile(init_py) and not os.path.islink(init_py):
                current = directory
                if is_last:
                    return init_py
                continue
            if os.path.isdir(directory) and os.path.isfile(init_pyi) and not os.path.islink(init_pyi):
                current = directory
                if is_last:
                    return init_pyi
                continue
            if is_last:
                for candidate in (module_py, module_pyi):
                    if os.path.isfile(candidate) and not os.path.islink(candidate):
                        return candidate
                return None
            if os.path.isdir(directory):
                current = directory
                continue
            return None
        return None

    def _resolve_import_path(self, source_path, module, level):
        module_parts = module.split(".") if module else []
        for root in self._import_roots(source_path):
            if level:
                file_parts = self._path_module_parts(source_path, root)
                if file_parts is None:
                    continue
                package_parts = file_parts if os.path.basename(source_path).startswith("__init__.") else file_parts[:-1]
                drop = level - 1
                if drop > len(package_parts):
                    continue
                base = package_parts[:len(package_parts) - drop] if drop else package_parts
                parts = base + module_parts
                token_offset = len(base)
            else:
                parts = module_parts
                token_offset = 0
            path = self._resolve_parts(root, parts)
            if path is not None and _within(self.root, os.path.realpath(path)):
                return path, root, parts, token_offset, module_parts
        return None, None, [], 0, module_parts

    def _module_symbol(self, path):
        key = "module\0" + path
        return key, [Location(path, 1, 1, 1, 1)], _entity("module", path=path)

    def _resolve_import(self, model, spec):
        path, root, parts, token_offset, module_parts = self._resolve_import_path(model.path, spec.module, spec.level)
        self._record_dependency(model, path)
        module_values = []
        for index, (name, location, explicit_prefix) in enumerate(spec.module_names):
            if location is None:
                continue
            if spec.kind == "import":
                prefix = explicit_prefix
            else:
                prefix = parts[:token_offset + index + 1]
            module_path = self._resolve_parts(root, prefix) if root is not None and prefix else None
            if module_path is None:
                key = "unresolved-module\0{}\0{}".format(location.path, location.key())
                module_values.append((name, location, {key}, [location], None))
            else:
                self._record_dependency(model, module_path)
                key, locations, entity = self._module_symbol(os.path.realpath(module_path))
                module_values.append((name, location, {key}, locations, entity))
            name, token_location, keys, targets, entity = module_values[-1]
            model.add_occurrence(Occurrence(name, token_location, keys=keys, targets=targets, entity=entity))

        if spec.kind == "import":
            if path is not None:
                imported_path = path
                if not spec.renamed and len(module_parts) > 1:
                    imported_path = self._resolve_parts(root, parts[:1]) or path
                key, locations, entity = self._module_symbol(os.path.realpath(imported_path))
                value_keys, value_locations = {key}, locations
            else:
                fallback_location = spec.alias_location
                if fallback_location is None and module_values:
                    fallback_location = module_values[0][1]
                if fallback_location is None:
                    return
                key = "fallback-import\0{}".format(fallback_location.key())
                value_keys, value_locations, entity = {key}, [fallback_location], None
        else:
            value_keys = set()
            value_locations = []
            entity = None
            if path is not None and spec.name:
                target = self._module_member(path, spec.name)
                if target is None:
                    child = self._module_child(path, spec.name)
                    if child is not None:
                        self._record_dependency(model, child)
                        key, locations, entity = self._module_symbol(child)
                        target = (set((key,)), locations, entity)
                if target is not None:
                    value_keys, value_locations, entity = target
            if not value_keys:
                fallback_location = spec.name_location or spec.alias_location
                if fallback_location is None:
                    return
                key = "fallback-import\0{}".format(fallback_location.key())
                value_keys, value_locations = {key}, [fallback_location]

        binding = spec.binding
        if spec.renamed:
            binding.alias_import = True
            if not binding.imported:
                binding.keys = set((binding.key,))
            for location in value_locations:
                binding.add_target(location)
            binding.entity = entity
            binding.imported = True
            if spec.alias_location is not None:
                binding.add_location(spec.alias_location)
                model.add_occurrence(Occurrence(spec.local_name, spec.alias_location,
                                                symbol=binding, entity=entity))
        else:
            if not binding.imported:
                binding.keys.clear()
                binding.targets[:] = []
                binding.imported = True
            binding.keys.update(value_keys)
            for location in value_locations:
                binding.add_target(location)
            binding.entity = entity
            if spec.kind == "import" and module_values:
                first = module_values[0]
                binding.keys = set(first[2])
                binding.targets = list(first[3])
                binding.entity = first[4]
        if spec.kind == "from" and spec.name_location is not None:
            if spec.renamed:
                source = spec.source_symbol
                if source is None:
                    source_key = "import-source\0{}\0{}".format(model.path, spec.name_location.key())
                    source = Symbol(spec.name, source_key)
                    spec.source_symbol = source
                source.keys = set(value_keys)
                source.targets = list(value_locations)
                source.entity = entity
                model.add_occurrence(Occurrence(spec.name, spec.name_location, symbol=source, entity=entity))
            else:
                # The imported token is also the local binding's declaration and reference.
                model.add_occurrence(Occurrence(spec.name, spec.name_location, symbol=binding, entity=entity))

    def _module_member(self, path, name):
        model = self.load(path)
        if model is None:
            return None
        binding = model.root_scope.bindings.get(name) if model.root_scope is not None else None
        if binding is None:
            return None
        return (set(binding.keys), list(binding.definition_locations()), binding.entity)

    def _module_child(self, path, name):
        for root in self._import_roots(path):
            parts = self._path_module_parts(path, root)
            if parts is None:
                continue
            child = self._resolve_parts(root, parts + [name])
            if child is not None:
                return os.path.realpath(child)
        return None

    def _prepare_entities(self, model, tree):
        for info in model.classes:
            info.bases = []
            for base in info.node.bases:
                value = self._infer(base, info.parent_scope)
                if value is not None and value.get("kind") == "class":
                    if value["info"] not in info.bases:
                        info.bases.append(value["info"])
        for function in model.functions:
            node = function.node
            parent_scope = function.binding.scope
            if node.returns is not None:
                function.return_entity = _entity_as_value(self._infer(node.returns, parent_scope))
            arguments = _arguments(node.args)
            for index, argument in enumerate(arguments):
                binding = function.scope.bindings.get(argument.arg)
                if binding is None:
                    continue
                if argument.annotation is not None:
                    binding.entity = _entity_as_value(self._infer(argument.annotation, parent_scope))
                elif function.owner_class is not None and index == 0:
                    if argument.arg == "cls" or _has_decorator(node, "classmethod"):
                        binding.entity = _entity("class", info=function.owner_class)
                    else:
                        binding.entity = _entity("instance", info=function.owner_class)
            if function.binding.entity is not None:
                function.binding.entity["info"].return_entity = function.return_entity

    def _infer(self, node, scope):
        if node is None:
            return None
        if isinstance(node, ast.Name):
            binding = self._lookup(scope, node.id)
            return binding.entity if binding is not None else None
        if isinstance(node, ast.Attribute):
            binding = self._attribute_binding(node.value, node.attr, scope)
            return binding.entity if binding is not None else None
        if isinstance(node, ast.Call):
            callee = self._infer(node.func, scope)
            if callee is None:
                return None
            if callee.get("kind") == "class":
                return _entity("instance", info=callee["info"])
            if callee.get("kind") == "function":
                return callee["info"].return_entity
            return None
        if isinstance(node, ast.NamedExpr):
            return self._infer(node.value, scope)
        if isinstance(node, ast.IfExp):
            return self._infer(node.body, scope) or self._infer(node.orelse, scope)
        if isinstance(node, ast.Await):
            return self._infer(node.value, scope)
        return None

    def _lookup(self, scope, name):
        if scope is None:
            return None
        module_scope = scope
        while module_scope.parent is not None:
            module_scope = module_scope.parent
        if name in scope.globals:
            return module_scope.bindings.get(name)
        if name in scope.nonlocals:
            current = scope.parent
            while current is not None and current.kind != "module":
                if current.kind != "class" and name in current.bindings:
                    return current.bindings[name]
                current = current.parent
            return None
        current = scope
        while current is not None:
            binding = current.bindings.get(name)
            if binding is not None:
                return binding
            parent = current.parent
            if current.kind in ("function", "lambda", "comprehension") and parent is not None and parent.kind == "class":
                parent = parent.parent
            current = parent
        return None

    def _attribute_binding(self, expression, name, scope):
        entity = self._infer(expression, scope)
        if entity is None:
            return None
        kind = entity.get("kind")
        if kind == "module":
            model = self.load(entity["path"])
            if model is None:
                return None
            binding = model.root_scope.bindings.get(name) if model.root_scope is not None else None
            if binding is not None:
                return binding
            child = self._module_child(entity["path"], name)
            if child is None:
                return None
            key, locations, child_entity = self._module_symbol(child)
            result = Symbol(name, key)
            result.keys = set((key,))
            result.targets = locations
            result.entity = child_entity
            return result
        if kind in ("class", "instance"):
            return self._class_member(entity["info"], name, set())
        return None

    def _class_member(self, info, name, visited):
        if info in visited:
            return None
        visited.add(info)
        binding = info.scope.bindings.get(name) if info.scope is not None else None
        if binding is not None:
            return binding
        attribute = info.attributes.get(name)
        if attribute is not None:
            return attribute
        for base in info.bases:
            binding = self._class_member(base, name, visited)
            if binding is not None:
                return binding
        return None

    def definition(self, path, line, character):
        model = self.load(path)
        if model is None:
            return []
        occurrence = self._occurrence_at(model, line, character)
        if occurrence is None:
            return []
        return [location.lsp() for location in self._unique_locations(occurrence.definition_locations())]

    def references(self, path, line, character):
        model = self.load(path)
        if model is None:
            return []
        target = self._occurrence_at(model, line, character)
        if target is None:
            return []
        keys = target.ref_keys()
        if not keys:
            return []
        result = []
        for candidate in self._python_files():
            candidate_model = self.load(candidate, target.name)
            if candidate_model is None:
                continue
            for occurrence in candidate_model.by_name.get(target.name, ()):
                if keys.intersection(occurrence.ref_keys()):
                    result.append(occurrence.location)
        return [location.lsp() for location in self._unique_locations(result)]

    def _occurrence_at(self, model, line, character):
        line_number = line + 1
        if line < 0 or character < 0:
            return None
        for occurrences in model.by_name.values():
            for occurrence in occurrences:
                location = occurrence.location
                if location.line == line_number and location.column - 1 <= character < location.end_column - 1:
                    return occurrence
        return None

    def _unique_locations(self, locations):
        unique = {}
        for location in locations:
            unique[location.key()] = location
        return [unique[key] for key in sorted(unique)]

    def _python_files(self):
        skipped = {"node_modules", "__pycache__", "site-packages"}
        for current, directories, files in os.walk(self.root, topdown=True, followlinks=False):
            try:
                if os.path.isfile(os.path.join(current, "pyvenv.cfg")):
                    directories[:] = []
                    continue
            except OSError:
                directories[:] = []
                continue
            directories[:] = sorted(
                name for name in directories
                if not name.startswith(".") and name not in skipped
                and not os.path.islink(os.path.join(current, name))
            )
            for name in sorted(files):
                if not name.endswith((".py", ".pyi")):
                    continue
                path = os.path.join(current, name)
                signature = _stat_file(path)
                if signature is None or signature[1] > MAX_FILE_BYTES:
                    continue
                real = os.path.realpath(path)
                if _within(self.root, real):
                    yield real


class Analyzer(object):
    def __init__(self, resolver, model):
        self.resolver = resolver
        self.model = model
        self.builder = model._scope_builder

    def walk(self, node, scope, declare, record):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._function(node, scope, declare, record)
            return
        if isinstance(node, ast.ClassDef):
            self._class(node, scope, declare, record)
            return
        if isinstance(node, ast.Lambda):
            child_scope = self.builder.node_scopes[id(node)]
            for expression in node.args.defaults + [item for item in node.args.kw_defaults if item is not None]:
                self.walk(expression, scope, declare, record)
            for argument in _arguments(node.args):
                self._argument(argument, child_scope, declare, record)
            self.walk(node.body, child_scope, declare, record)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            self._comprehension(node, scope, declare, record)
            return
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return
        if isinstance(node, ast.Name):
            binding = self.resolver._lookup(scope, node.id)
            location = _ast_location(self.model, node, node.id)
            if location is not None:
                if declare and isinstance(node.ctx, (ast.Store, ast.Del)) and binding is not None:
                    binding.add_location(location)
                if record and binding is not None:
                    self.model.add_occurrence(Occurrence(node.id, location, symbol=binding))
            return
        if isinstance(node, ast.Attribute):
            self.walk(node.value, scope, declare, record)
            location = _ast_attribute_location(self.model, node)
            if location is not None:
                if declare and isinstance(node.ctx, (ast.Store, ast.Del)):
                    self._declare_attribute(node, scope, location)
                if record:
                    binding = self.resolver._attribute_binding(node.value, node.attr, scope)
                    if binding is not None:
                        self.model.add_occurrence(Occurrence(node.attr, location, symbol=binding))
            return
        if isinstance(node, ast.Assign):
            for value in node.value if isinstance(node.value, (list, tuple)) else (node.value,):
                self.walk(value, scope, declare, record)
            entity = self.resolver._infer(node.value, scope) if declare else None
            for target in node.targets:
                if declare:
                    self._set_entity(target, scope, entity)
                self.walk(target, scope, declare, record)
            return
        if isinstance(node, ast.AnnAssign):
            self.walk(node.annotation, scope, declare, record)
            if node.value is not None:
                self.walk(node.value, scope, declare, record)
            entity = self.resolver._infer(node.value, scope) if declare and node.value is not None else None
            if entity is None and declare:
                entity = _entity_as_value(self.resolver._infer(node.annotation, scope))
            if declare:
                self._set_entity(node.target, scope, entity)
            self.walk(node.target, scope, declare, record)
            return
        if isinstance(node, ast.AugAssign):
            self.walk(node.target, scope, declare, record)
            self.walk(node.value, scope, declare, record)
            return
        if isinstance(node, ast.NamedExpr):
            self.walk(node.value, scope, declare, record)
            entity = self.resolver._infer(node.value, scope) if declare else None
            if declare:
                self._set_entity(node.target, scope, entity)
            self.walk(node.target, scope, declare, record)
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            self.walk(node.iter, scope, declare, record)
            self.walk(node.target, scope, declare, record)
            for statement in node.body + node.orelse:
                self.walk(statement, scope, declare, record)
            return
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                self.walk(item.context_expr, scope, declare, record)
                if item.optional_vars is not None:
                    self.walk(item.optional_vars, scope, declare, record)
            for statement in node.body:
                self.walk(statement, scope, declare, record)
            return
        if isinstance(node, ast.ExceptHandler):
            if node.type is not None:
                self.walk(node.type, scope, declare, record)
            if node.name:
                location = _find_name_after(self.model, node, "as", node.name)
                binding = self.resolver._lookup(scope, node.name)
                if location is not None:
                    if declare and binding is not None:
                        binding.add_location(location)
                    if record and binding is not None:
                        self.model.add_occurrence(Occurrence(node.name, location, symbol=binding))
            for statement in node.body:
                self.walk(statement, scope, declare, record)
            return
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            if record:
                keyword = "global" if isinstance(node, ast.Global) else "nonlocal"
                for name, location in _find_names_after(self.model, node, keyword, node.names):
                    binding = self.resolver._lookup(scope, name)
                    if binding is not None:
                        self.model.add_occurrence(Occurrence(name, location, symbol=binding))
            return
        for child in ast.iter_child_nodes(node):
            self.walk(child, scope, declare, record)

    def _function(self, node, scope, declare, record):
        binding = scope.binding(node.name)
        location = _find_name_after(self.model, node, "def", node.name)
        if location is not None:
            if declare:
                binding.add_location(location)
            if record:
                self.model.add_occurrence(Occurrence(node.name, location, symbol=binding))
        for expression in node.decorator_list:
            self.walk(expression, scope, declare, record)
        for expression in node.args.defaults + [item for item in node.args.kw_defaults if item is not None]:
            self.walk(expression, scope, declare, record)
        for argument in _arguments(node.args):
            if argument.annotation is not None:
                self.walk(argument.annotation, scope, declare, record)
        if node.returns is not None:
            self.walk(node.returns, scope, declare, record)
        child_scope = self.builder.node_scopes[id(node)]
        for argument in _arguments(node.args):
            self._argument(argument, child_scope, declare, record)
        for statement in node.body:
            self.walk(statement, child_scope, declare, record)

    def _class(self, node, scope, declare, record):
        binding = scope.binding(node.name)
        location = _find_name_after(self.model, node, "class", node.name)
        if location is not None:
            if declare:
                binding.add_location(location)
            if record:
                self.model.add_occurrence(Occurrence(node.name, location, symbol=binding))
        for expression in node.decorator_list + node.bases:
            self.walk(expression, scope, declare, record)
        for keyword in node.keywords:
            self.walk(keyword.value, scope, declare, record)
        child_scope = self.builder.node_scopes[id(node)]
        for statement in node.body:
            self.walk(statement, child_scope, declare, record)

    def _argument(self, argument, scope, declare, record):
        location = _ast_location(self.model, argument, argument.arg)
        if location is None:
            return
        binding = scope.bindings.get(argument.arg)
        if binding is None:
            return
        if declare:
            binding.add_location(location)
        if record:
            self.model.add_occurrence(Occurrence(argument.arg, location, symbol=binding))

    def _comprehension(self, node, scope, declare, record):
        generators = node.generators
        if not generators:
            return
        self.walk(generators[0].iter, scope, declare, record)
        child_scope = self.builder.node_scopes[id(node)]
        for index, generator in enumerate(generators):
            if index:
                self.walk(generator.iter, child_scope, declare, record)
            self.walk(generator.target, child_scope, declare, record)
            for condition in generator.ifs:
                self.walk(condition, child_scope, declare, record)
        if isinstance(node, ast.DictComp):
            self.walk(node.key, child_scope, declare, record)
            self.walk(node.value, child_scope, declare, record)
        else:
            self.walk(node.elt, child_scope, declare, record)

    def _set_entity(self, target, scope, entity):
        if isinstance(target, ast.Name):
            binding = self.resolver._lookup(scope, target.id)
            if binding is not None and entity is not None:
                binding.entity = entity
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                self._set_entity(item, scope, entity)
        elif isinstance(target, ast.Attribute):
            self._declare_attribute(target, scope, _ast_attribute_location(self.model, target), entity)

    def _declare_attribute(self, node, scope, location, entity=None):
        if location is None or scope.owner_class is None or not isinstance(node.value, ast.Name):
            return
        base = self.resolver._lookup(scope, node.value.id)
        if base is None or base.entity is None:
            return
        base_entity = base.entity
        if base_entity.get("kind") not in ("instance", "class") or base_entity.get("info") is not scope.owner_class:
            return
        attribute = scope.owner_class.attributes.get(node.attr)
        if attribute is None:
            key = "attribute\0{}\0{}".format(scope.owner_class.binding.key, node.attr)
            attribute = Symbol(node.attr, key)
            scope.owner_class.attributes[node.attr] = attribute
        attribute.add_location(location)
        if entity is not None:
            attribute.entity = entity


def _has_decorator(node, name):
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Name) and decorator.id == name:
            return True
        if isinstance(decorator, ast.Attribute) and decorator.attr == name:
            return True
    return False


def _location_inside_root(root, path):
    try:
        return os.path.commonpath((root, os.path.realpath(path))) == root
    except (ValueError, OSError):
        return False


def _read_frame(stream):
    headers = []
    while True:
        line = stream.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        headers.append(line)
    length = None
    for line in headers:
        try:
            key, value = line.decode("ascii").split(":", 1)
        except (UnicodeDecodeError, ValueError):
            continue
        if key.strip().lower() == "content-length":
            try:
                length = int(value.strip())
            except ValueError:
                length = -1
            break
    if length is None or length < 0:
        raise ValueError("invalid Content-Length header")
    parts = []
    remaining = length
    while remaining:
        part = stream.read(remaining)
        if not part:
            return None
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def _write_message(value):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()


def _error(request_id, code, message):
    _write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _file_uri_path(value):
    return _uri_path(value)


def _initialize_root(params):
    if isinstance(params, dict):
        root = _file_uri_path(params.get("rootUri"))
        if root is not None:
            return root
        folders = params.get("workspaceFolders")
        if isinstance(folders, list) and folders and isinstance(folders[0], dict):
            root = _file_uri_path(folders[0].get("uri"))
            if root is not None:
                return root
    return os.path.realpath(os.getcwd())


def _request_path(params, root):
    if not isinstance(params, dict):
        return None
    document = params.get("textDocument")
    if not isinstance(document, dict):
        return None
    path = _file_uri_path(document.get("uri"))
    if path is None or not _location_inside_root(root, path):
        return None
    return path


def _request_position(params):
    if not isinstance(params, dict):
        return None
    position = params.get("position")
    if not isinstance(position, dict):
        return None
    line = position.get("line")
    character = position.get("character")
    if not isinstance(line, int) or isinstance(line, bool) or not isinstance(character, int) or isinstance(character, bool):
        return None
    return line, character


def serve():
    if sys.version_info < (3, 8):
        sys.stderr.write("quirky navigation needs Python 3.8 or newer, found {}.{}\n".format(
            sys.version_info[0], sys.version_info[1]))
        sys.stderr.flush()
        return 3
    root = os.path.realpath(os.getcwd())
    resolver = Resolver(root)
    initialized = False
    shutdown = False
    while True:
        try:
            body = _read_frame(sys.stdin.buffer)
        except ValueError as error:
            _error(None, -32700, str(error))
            continue
        if body is None:
            return 0
        try:
            message = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            _error(None, -32700, "Parse error")
            continue
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            request_id = message.get("id") if isinstance(message, dict) and "id" in message else None
            _error(request_id, -32600, "Invalid Request")
            continue
        method = message.get("method")
        has_id = "id" in message
        request_id = message.get("id") if has_id else None
        if not isinstance(method, str):
            if has_id:
                _error(request_id, -32600, "Invalid Request")
            continue
        if method == "exit":
            return 0 if shutdown else 1
        if method in ("initialized", "$/cancelRequest", "textDocument/didOpen",
                      "textDocument/didChange", "textDocument/didClose", "textDocument/didSave",
                      "workspace/didChangeConfiguration"):
            continue
        if method == "initialize":
            if not has_id:
                continue
            root = _initialize_root(message.get("params"))
            resolver = Resolver(root)
            initialized = True
            _write_message({"jsonrpc": "2.0", "id": request_id, "result": {
                "capabilities": {
                    "positionEncoding": "utf-16",
                    "definitionProvider": True,
                    "referencesProvider": True,
                },
                "serverInfo": {"name": "quirky-python-resolver"},
            }})
            continue
        if method == "shutdown":
            shutdown = True
            if has_id:
                _write_message({"jsonrpc": "2.0", "id": request_id, "result": None})
            continue
        if method in ("textDocument/definition", "textDocument/references"):
            if not has_id:
                continue
            if not initialized:
                _error(request_id, -32002, "Server not initialized")
                continue
            try:
                params = message.get("params")
                path = _request_path(params, root)
                position = _request_position(params)
                if path is None or position is None:
                    result = []
                elif method == "textDocument/definition":
                    result = resolver.definition(path, position[0], position[1])
                else:
                    result = resolver.references(path, position[0], position[1])
                _write_message({"jsonrpc": "2.0", "id": request_id, "result": result})
            except Exception as error:
                _error(request_id, -32603, "{}: {}".format(type(error).__name__, error))
            continue
        if has_id:
            _error(request_id, -32601, "Method not found: {}".format(method))


if __name__ == "__main__":
    sys.exit(serve())
