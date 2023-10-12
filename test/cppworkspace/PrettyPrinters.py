import gdb
import gdb.printing
import re
from time import perf_counter as pc


class VectorPrinter:
    "Print a Vector<T>"

    def __init__(self, val):
        self.val = val
        self.size = int(self.val["m_size"])

    def children(self):
        for i in range(0, self.size):
            yield (f"{i}", (self.val["m_elements"] + i).dereference())

    def children_range(self, start, end):
        for i in range(start, end):
          yield (f"{i}", (self.val["m_elements"] + i).dereference())

    def to_string(self):
        return f"Vector<T> is ...?"

    def display_hint(self):
        return 'array'

    def num_children(self):
        return self.size

class VectorIteratorPrinter:
    "Print std::vector::iterator"

    def __init__(self, val):
        self.val = val

    def to_string(self):
        if not self.val['_M_current']:
            return 'non-dereferenceable iterator for std::vector'
        return str(self.val['_M_current'].dereference())

class StringPrinter:
    "Print a std::basic_string of some kind"

    def __init__(self, val, typename = None):
        self.val = val
        self.typename = typename

    def to_string(self):
        # Make sure &string works, too.
        type = self.val.type
        if type.code == gdb.TYPE_CODE_REF:
            type = type.target ()

        # Calculate the length of the string so that to_string returns
        # the string according to length, not according to first null
        # encountered.
        ptr = self.val ["m_ptr"]
        return ptr.string(length = self.val["m_length"])

    def display_hint (self):
        return 'string'

def build_pretty_printer():
    pp = gdb.printing.RegexpCollectionPrettyPrinter(
        "dap_library")
    pp.add_printer('String', '^String$', StringPrinter)
    pp.add_printer('Vector', '^Vector$', VectorPrinter)
    return pp

def str_lookup_function(val):
    lookup_tag = val.type.tag
    if lookup_tag is None:
        return None
    regex = re.compile("^Vector<.*>$")
    if regex.match(lookup_tag):
        return VectorPrinter(val)
    return None

def vec_lookup_function(val):
    lookup_tag = val.type.tag
    if lookup_tag is None:
        return None
    regex = re.compile("^String$")
    if regex.match(lookup_tag):
        return StringPrinter(val=val)
    return None

gdb.selected_inferior().progspace.objfiles()[0].pretty_printers.append(str_lookup_function)
gdb.selected_inferior().progspace.objfiles()[0].pretty_printers.append(vec_lookup_function)

# gdb.printing.register_pretty_printer(gdb.current_objfile(), build_pretty_printer())