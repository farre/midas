#include "structrequests.hpp"

#include <todo.hpp>
#include <date.hpp>

#include <vector>
#include <iostream>

namespace structsrequests
{
    Struct variablesRequestTest(Struct s)
    {
        // set first breakpoint here
        const auto new_i = s.i + 10;
        const auto new_f = s.f + 10.10f;
        s.i = new_i;
        s.f = new_f;
        return s;
    }

    void variablesRequestTestReference(Struct &s)
    {
        const auto i = s.i + 10;
        const auto f = s.f + 10.10f;
        s.i = i;
        s.f = f;
    }

    int testSubChildUpdate(Bar *b)
    {
        b->j++;
        variablesRequestTestReference(*b->s);
        auto res = b->s->f;
        return res;
    }

    void variablesRequestTestPointer(Struct *s)
    {
        auto local_ptr = s;
        const auto i = local_ptr->i + 10;
        const auto f = local_ptr->f + 10.10f;
        variablesRequestTestReference(*s);
        local_ptr->i += i;
        local_ptr->f += f;
        variablesRequestTestReference(*s);
        local_ptr = nullptr;
    }

    void do_todo(Todo &t)
    {
        std::cout << t.title() << std::endl;
    }

    Todo move_todo(Todo &&t)
    {
        std::cout << t.title() << std::endl;
        return t;
    }

    void main()
    {
        Todo tmp{"Test local struct", Date{.day = 20, .month = 2, .year = 2022}};
        auto d = tmp.date();
        auto tmpptr = new Todo{"Pointer to Todo", Date{.day = 25, .month = 1, .year = 2022}};
        Foo f{.name = "hello world", .k = 10};
        int i = 0;
        Todo::post_pone(tmpptr, d);
        auto somestruct = new Struct{.i = 10, .f = 10.10f, .name = "somestruct"};
        auto copied_somestruct = variablesRequestTest(*somestruct);
        variablesRequestTestPointer(&copied_somestruct);
        auto barptr = new Bar{.j = 100, .s = new Struct{.i = 10, .f = 10.10f, .name = "somestruct_refByBar"}};
        i = testSubChildUpdate(barptr);
        do_todo(*tmpptr);
        auto a = move_todo(std::move(tmp));

        std::vector<Todo> todos{};
        todos.push_back(Todo{"Make test app for debugger extension",
                             Date{.day = 3, .month = 11, .year = 2021}});
        todos.push_back(Todo{"Read code-debug & look for useful stuff",
                             Date{.day = 4, .month = 11, .year = 2021}});
        todos.push_back(Todo{"Read vscode-mock-debug & rip out things of use",
                             Date{.day = 5, .month = 11, .year = 2021}});

        std::cout << "Things to do: " << Todo::todo_count() << std::endl;
        for (const auto &t : todos)
        {
            std::cout << "\tTodo id " << t.id() << ": " << t.title() << " @" << t.date()
                      << std::endl;
        }
    } // namespace structsrequests
}