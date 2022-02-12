#include <string>
#include <vector>
#include <map>
#include <algorithm>

using usize = std::size_t;

static int W_ID = 0;
struct Ref {
    int* value = nullptr;
    bool has_value() const { return value != nullptr; }
};

struct Foo {
    std::string name;
    int id;
    float f;
};

struct Widget {
    
    static Widget clone_from(std::string name, Widget* w) {
        if(w->id.has_value()) {
            return Widget{.m_name = name, .id = Ref{.value = w->id.value}};
        } else {
            return Widget { .m_name = std::move(name), .id = Ref{.value = new int{W_ID++} } };
        }
    }

    void set_foo(Foo* foo) {
        this->foo = foo;
    }
    std::string m_name;
    Ref id;
    Foo* foo = nullptr;
};

void test_ptrs_main() {
    Foo* f = nullptr;
    f = new Foo{.name = "Foo type", .id = 10, .f = 3.14f};
    auto b = new Foo{.name = "Foo type bar", .id = 30, .f = 444.14f};
    Widget foo{.m_name = "foo", .id = Ref{.value = nullptr}};
    auto bar = Widget::clone_from("bar", &foo);
    foo.set_foo(f);
    bar.set_foo(b);
}
